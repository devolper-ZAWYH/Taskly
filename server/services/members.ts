/**
 * Workspace membership, as managed by a workspace Administrator.
 * A user is global; a membership attaches them to one workspace with a role.
 */
import { AppError } from "@/lib/api/core"
import type {
  AddMemberResult,
  MyInvitation,
  Page,
  Role,
  WorkspaceInvitation,
  WorkspaceMember,
} from "@/lib/types"
import {
  requireUser,
  requireWorkspace,
  requireWorkspaceAdmin,
  type Actor,
  type Ctx,
} from "@/server/context"
import { hashPassword, newId, newSessionToken, newTemporaryPassword } from "@/server/crypto"
import { userByEmail } from "@/server/emails"
import { enqueue } from "@/server/google/queue"
import { mailConfigured, sendMail } from "@/server/mail/send"
import { workspaceInviteMail } from "@/server/mail/templates"
import { sendInvitation, workspaceInviter } from "@/server/services/password-links"
import { notify } from "@/server/services/notifications"
import { appOrigin, appUrl } from "@/server/settings"
import {
  all,
  avatarUrl,
  first,
  logoUrl,
  MEMBER_COLUMNS,
  nowIso,
  run,
  toMember,
  type MemberRow,
  type UserRow,
} from "@/server/db"
import {
  addMemberInput,
  assertEmail,
  bool,
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
  const where = `ms.account_id = ? AND (? = '' OR u.name LIKE ? ESCAPE '\\' OR COALESCE(ms.email, u.email) LIKE ? ESCAPE '\\')`
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
 * Add someone to this workspace by email.
 *
 * - A new email gets an account and joins at once; when email is set up they
 *   get an invitation to choose a password, otherwise (or if sending fails) a
 *   temporary password for the administrator to share.
 * - Someone who already has an account is invited: they join only when they
 *   accept (on /workspaces), and get an email and a notification about it.
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
  // Any of their confirmed addresses finds them: one person, one account.
  const existing = await userByEmail(ctx.db, email)
  if (existing) {
    if (await findMember(ctx, accountId, existing.id)) throw new AppError("alreadyMember")
    const invitation = await inviteExisting(ctx, actor, existing, input.role, email)
    return { member: null, invitation, invited: false, temporaryPassword: null }
  }

  const now = nowIso()
  const invite = await mailConfigured(ctx)
  // Invited: nobody knows this random password; they choose their own from the email.
  let temporaryPassword = invite ? null : newTemporaryPassword()
  const userId = newId("u")
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO users (id, name, email, password_hash, is_operator, active, locale, invited_at, created_at)
         VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
      )
      .bind(
        userId,
        nameFromEmail(email),
        email,
        await hashPassword(temporaryPassword ?? newSessionToken()),
        actor.user.locale,
        invite ? now : null,
        now,
      ),
    ctx.db
      .prepare(
        "INSERT INTO memberships (id, account_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(newId("mb"), accountId, userId, input.role, now),
  ])

  let invited = false
  if (invite) {
    try {
      await sendInvitation(ctx, workspaceInviter(actor), userId)
      invited = true
    } catch {
      // Couldn't email them: fall back to a temporary password the admin shares.
      temporaryPassword = newTemporaryPassword()
      await run(
        ctx.db,
        "UPDATE users SET password_hash = ?, invited_at = NULL WHERE id = ?",
        await hashPassword(temporaryPassword),
        userId,
      )
    }
  }
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
  return {
    member: (await findMember(ctx, accountId, userId))!,
    invitation: null,
    invited,
    temporaryPassword,
  }
}

// ---- Invitations for people who already have an account --------------------------

type InvitationRow = {
  id: string
  account_id: string
  user_id: string
  role: Role
  invited_by: string | null
  created_at: string
  name: string
  email: string
  avatar_updated_at: string | null
  inviter: string | null
}

// The address it was sent to (what this workspace knows them by), else their primary.
const INVITATION_COLUMNS = `wi.*, u.name, COALESCE(wi.email, u.email) AS email, u.avatar_updated_at,
  (SELECT name FROM users WHERE id = wi.invited_by) AS inviter`

const toInvitation = (row: InvitationRow): WorkspaceInvitation => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  email: row.email,
  avatarUrl: avatarUrl(row.user_id, row.avatar_updated_at),
  role: row.role,
  invitedBy: row.inviter,
  createdAt: row.created_at,
})

async function findInvitation(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<InvitationRow | null> {
  return first<InvitationRow>(
    ctx.db,
    `SELECT ${INVITATION_COLUMNS} FROM workspace_invitations wi JOIN users u ON u.id = wi.user_id
     WHERE wi.id = ? AND wi.account_id = ?`,
    id,
    accountId,
  )
}

async function inviteExisting(
  ctx: Ctx,
  actor: Actor,
  user: UserRow,
  role: Role,
  email: string,
): Promise<WorkspaceInvitation> {
  const id = newId("wi")
  const result = await ctx.db
    .prepare(
      `INSERT INTO workspace_invitations (id, account_id, user_id, role, invited_by, email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, user_id) DO NOTHING`,
    )
    .bind(
      id,
      actor.account.id,
      user.id,
      role,
      actor.id,
      // Their primary needs no override; another address becomes this workspace's.
      email === user.email ? null : email,
      nowIso(),
    )
    .run()
  if (!result.meta.changes) throw new AppError("alreadyInvited")
  const row = (await findInvitation(ctx, actor.account.id, id))!
  await announceInvitation(ctx, actor, row)
  return toInvitation(row)
}

/**
 * Tell the invitee: a notification (in the app and by push, per their
 * preferences) and, since it needs an answer, an email whatever their
 * email preference says.
 */
async function announceInvitation(ctx: Ctx, actor: Actor, row: InvitationRow): Promise<void> {
  await notify(ctx, {
    recipients: [row.user_id],
    actorId: actor.id,
    event: "workspace_invited",
    accountId: actor.account.id,
    data: { actor: actor.user.name, workspace: actor.account.name },
    link: "/workspaces",
    email: false,
  })
  if (!(await mailConfigured(ctx))) return
  const user = await first<{ locale: string }>(ctx.db, "SELECT locale FROM users WHERE id = ?", row.user_id)
  const url = await appUrl(ctx, "/workspaces")
  const origin = await appOrigin(ctx)
  ctx.waitUntil(
    sendMail(ctx, [
      {
        to: { name: row.name, email: row.email },
        mail: workspaceInviteMail(user?.locale === "ar" ? "ar" : "en", {
          name: row.name,
          actor: actor.user.name,
          workspace: actor.account.name,
          role: row.role,
          url,
          origin,
        }),
      },
    ]).catch((error) => console.error("workspace invitation email failed", error)),
  )
}

/** Invitations this workspace is waiting on (people with accounts who haven't answered). */
export async function listInvitations(ctx: Ctx, accountId: string): Promise<WorkspaceInvitation[]> {
  await requireWorkspaceAdmin(ctx, accountId)
  const rows = await all<InvitationRow>(
    ctx.db,
    `SELECT ${INVITATION_COLUMNS} FROM workspace_invitations wi JOIN users u ON u.id = wi.user_id
     WHERE wi.account_id = ? ORDER BY wi.created_at DESC`,
    accountId,
  )
  return rows.map(toInvitation)
}

/** Remind them: the notification and email again. */
export async function resendInvitation(ctx: Ctx, accountId: string, id: unknown): Promise<void> {
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const row = await findInvitation(ctx, accountId, str(id, 100))
  if (!row) throw new AppError("notFound")
  await announceInvitation(ctx, actor, row)
}

export async function cancelInvitation(ctx: Ctx, accountId: string, id: unknown): Promise<void> {
  await requireWorkspaceAdmin(ctx, accountId)
  await run(
    ctx.db,
    "DELETE FROM workspace_invitations WHERE id = ? AND account_id = ?",
    str(id, 100),
    accountId,
  )
}

/** Invitations waiting for the signed-in person, from active workspaces. */
export async function listMyInvitations(ctx: Ctx): Promise<MyInvitation[]> {
  const me = await requireUser(ctx)
  const rows = await all<InvitationRow & { account_name: string; logo_updated_at: string | null }>(
    ctx.db,
    `SELECT ${INVITATION_COLUMNS}, a.name AS account_name, a.logo_updated_at
     FROM workspace_invitations wi
     JOIN users u ON u.id = wi.user_id
     JOIN accounts a ON a.id = wi.account_id AND a.active = 1
     WHERE wi.user_id = ? ORDER BY wi.created_at DESC`,
    me.id,
  )
  return rows.map((row) => ({
    id: row.id,
    account: {
      id: row.account_id,
      name: row.account_name,
      logoUrl: logoUrl(row.account_id, row.logo_updated_at),
    },
    role: row.role,
    invitedBy: row.inviter,
    createdAt: row.created_at,
  }))
}

/**
 * Accept (join with the invited role) or decline an invitation of yours. The
 * administrator who sent it hears the answer.
 */
export async function answerInvitation(
  ctx: Ctx,
  id: unknown,
  accept: unknown,
): Promise<{ accountId: string | null }> {
  const me = await requireUser(ctx)
  const joining = bool(accept)
  const row = await first<InvitationRow & { account_name: string; active: number }>(
    ctx.db,
    `SELECT ${INVITATION_COLUMNS}, a.name AS account_name, a.active
     FROM workspace_invitations wi
     JOIN users u ON u.id = wi.user_id
     JOIN accounts a ON a.id = wi.account_id
     WHERE wi.id = ? AND wi.user_id = ?`,
    str(id, 100),
    me.id,
  )
  if (!row) throw new AppError("notFound")
  if (joining && row.active !== 1) throw new AppError("workspaceInactive")
  const statements: D1PreparedStatement[] = []
  if (joining) {
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO memberships (id, account_id, user_id, role, email, created_at)
           SELECT ?, ?, ?, ?, (
             -- The address it was sent to, if it's still one of their confirmed ones.
             SELECT wi.email FROM workspace_invitations wi WHERE wi.id = ? AND wi.email IN (
               SELECT email FROM user_emails WHERE user_id = ? AND verified_at IS NOT NULL)
           ), ?
           WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE account_id = ? AND user_id = ?)`,
        )
        .bind(
          newId("mb"),
          row.account_id,
          me.id,
          row.role,
          row.id,
          me.id,
          nowIso(),
          row.account_id,
          me.id,
        ),
    )
  }
  // After the membership, which copies the invitation's address.
  statements.push(ctx.db.prepare("DELETE FROM workspace_invitations WHERE id = ?").bind(row.id))
  await ctx.db.batch(statements)
  if (row.invited_by) {
    await notify(ctx, {
      recipients: [row.invited_by],
      actorId: me.id,
      event: joining ? "workspace_invite_accepted" : "workspace_invite_declined",
      accountId: row.account_id,
      data: { actor: me.name, workspace: row.account_name },
      link: `/w/${row.account_id}/members`,
    })
  }
  if (!joining) return { accountId: null }
  // If they've connected Google, the workspace's list and calendar appear there.
  await enqueue(ctx, [{ kind: "setup_member", userId: me.id, accountId: row.account_id }])
  return { accountId: row.account_id }
}

/** Email a new password link to a member who hasn't set their password yet. */
export async function resendInvite(ctx: Ctx, accountId: string, userId: unknown): Promise<void> {
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const member = await findMember(ctx, accountId, str(userId, 100))
  if (!member) throw new AppError("notFound")
  if (!member.invitePending) throw new AppError("badRequest")
  if (!(await mailConfigured(ctx))) throw new AppError("mailNotConfigured")
  await sendInvitation(ctx, workspaceInviter(actor), member.id)
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
