/**
 * Workspace membership, as managed by a workspace Administrator.
 * A user is global; a membership attaches them to one workspace with a role.
 */
import { AppError } from "@/lib/api/core"
import type { AddMemberResult, Page, WorkspaceMember } from "@/lib/types"
import { requireWorkspace, requireWorkspaceAdmin, type Ctx } from "@/server/context"
import { hashPassword, newId, newTemporaryPassword } from "@/server/crypto"
import { enqueue } from "@/server/google/queue"
import { notify } from "@/server/services/notifications"
import {
  all,
  first,
  MEMBER_COLUMNS,
  nowIso,
  toMember,
  type MemberRow,
  type UserRow,
} from "@/server/db"
import {
  addMemberInput,
  assertEmail,
  int,
  isObject,
  normalizeEmail,
  str,
  updateMemberInput,
} from "@/server/validate"

export async function membersOf(db: D1Database, accountId: string): Promise<WorkspaceMember[]> {
  const rows = await all<MemberRow>(
    db,
    `SELECT ${MEMBER_COLUMNS} FROM memberships ms JOIN users u ON u.id = ms.user_id
     WHERE ms.account_id = ? ORDER BY u.name COLLATE NOCASE`,
    accountId,
  )
  return rows.map(toMember)
}

/** Everyone in the workspace (assignee picker, avatars). */
export async function listPeople(ctx: Ctx, accountId: string): Promise<WorkspaceMember[]> {
  await requireWorkspace(ctx, accountId)
  return membersOf(ctx.db, accountId)
}

export async function listMembers(
  ctx: Ctx,
  accountId: string,
  params: unknown,
): Promise<Page<WorkspaceMember>> {
  await requireWorkspaceAdmin(ctx, accountId)
  if (!isObject(params)) throw new AppError("badRequest")
  const search = str(params.search, 200).trim()
  const page = int(params.page, 1, 100_000)
  const pageSize = int(params.pageSize, 1, 100)
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const where = `ms.account_id = ? AND (? = '' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`
  const binds = [accountId, search, like, like]
  const [rows, count] = await Promise.all([
    all<MemberRow>(
      ctx.db,
      `SELECT ${MEMBER_COLUMNS} FROM memberships ms JOIN users u ON u.id = ms.user_id
       WHERE ${where} ORDER BY u.active DESC, u.name COLLATE NOCASE LIMIT ? OFFSET ?`,
      ...binds,
      pageSize,
      (page - 1) * pageSize,
    ),
    first<{ total: number }>(
      ctx.db,
      `SELECT COUNT(*) AS total FROM memberships ms JOIN users u ON u.id = ms.user_id WHERE ${where}`,
      ...binds,
    ),
  ])
  return { items: rows.map(toMember), total: count?.total ?? 0 }
}

async function findMember(
  ctx: Ctx,
  accountId: string,
  userId: string,
): Promise<WorkspaceMember | null> {
  const row = await first<MemberRow>(
    ctx.db,
    `SELECT ${MEMBER_COLUMNS} FROM memberships ms JOIN users u ON u.id = ms.user_id
     WHERE ms.account_id = ? AND ms.user_id = ?`,
    accountId,
    userId,
  )
  return row ? toMember(row) : null
}

/** "jane.doe@acme.com" → "Jane Doe": a starting name the person can change in Settings. */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email
  const words = local.split(/[._\-+]+/).filter(Boolean)
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
  return name || email
}

/**
 * Add someone to this workspace by email. An existing sign-in simply joins;
 * a new email gets an account with a temporary password for the admin to share.
 */
export async function addMember(
  ctx: Ctx,
  accountId: string,
  raw: unknown,
): Promise<AddMemberResult> {
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const input = addMemberInput(raw)
  const email = normalizeEmail(input.email)
  assertEmail(email)
  const existing = await first<UserRow>(
    ctx.db,
    "SELECT * FROM users WHERE email = ? AND deleted_at IS NULL",
    email,
  )
  const now = nowIso()
  const statements: D1PreparedStatement[] = []
  let userId: string
  let temporaryPassword: string | null = null

  if (existing) {
    userId = existing.id
    if (await findMember(ctx, accountId, userId)) throw new AppError("alreadyMember")
  } else {
    temporaryPassword = newTemporaryPassword()
    userId = newId("u")
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO users (id, name, email, password_hash, is_operator, active, locale, created_at)
           VALUES (?, ?, ?, ?, 0, 1, 'en', ?)`,
        )
        .bind(userId, nameFromEmail(email), email, await hashPassword(temporaryPassword), now),
    )
  }
  statements.push(
    ctx.db
      .prepare(
        "INSERT INTO memberships (id, account_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(newId("mb"), accountId, userId, input.role, now),
  )
  await ctx.db.batch(statements)
  await notify(ctx, {
    recipients: [userId],
    actorId: actor.id,
    event: "workspace_added",
    accountId,
    data: { actor: actor.user.name, workspace: actor.account.name },
    link: `/w/${accountId}/dashboard`,
  })
  // If they've connected Google, the workspace's list and calendar appear there.
  await enqueue(ctx, [{ kind: "setup_member", userId, accountId }])
  return { member: (await findMember(ctx, accountId, userId))!, temporaryPassword }
}

/** Administrators only change someone's role here; their account stays theirs. */
export async function updateMember(
  ctx: Ctx,
  accountId: string,
  userId: unknown,
  raw: unknown,
): Promise<WorkspaceMember> {
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const id = str(userId, 100)
  const { role } = updateMemberInput(raw)
  const target = await findMember(ctx, accountId, id)
  if (!target) throw new AppError("notFound")
  if (id === actor.id && role !== "administrator") throw new AppError("selfDemote")
  await ctx.db
    .prepare("UPDATE memberships SET role = ? WHERE id = ?")
    .bind(role, target.membershipId)
    .run()
  return { ...target, role }
}

/** Revoke someone's access to this workspace (their account and other workspaces stay). */
export async function removeMember(ctx: Ctx, accountId: string, userId: unknown): Promise<void> {
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const id = str(userId, 100)
  if (id === actor.id) throw new AppError("selfRemove")
  await ctx.db
    .prepare("DELETE FROM memberships WHERE account_id = ? AND user_id = ?")
    .bind(accountId, id)
    .run()
  // Their copy of this workspace leaves their Google account too.
  await enqueue(ctx, [{ kind: "purge_member", userId: id, accountId }])
}
