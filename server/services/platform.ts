/**
 * Platform operator console: accounts (workspaces), users, and the
 * memberships that attach users to accounts. Operator-only.
 */
import { AppError } from "@/lib/api/core"
import {
  LOGO_TYPES,
  MAX_LOGO_BYTES,
  type Account,
  type AccountSummary,
  type PublicUser,
  type Role,
  type UserSummary,
  type WorkspaceMember,
} from "@/lib/types"
import { requireOperator, type Ctx } from "@/server/context"
import { hashPassword, newId } from "@/server/crypto"
import {
  all,
  first,
  nowIso,
  run,
  toAccount,
  toPublicUser,
  type AccountRow,
  type UserRow,
} from "@/server/db"
import { looksLikeImage } from "@/server/images"
import { membersOf } from "@/server/services/members"
import { enqueue } from "@/server/google/queue"
import { notify } from "@/server/services/notifications"
import {
  assertEmail,
  bool,
  isObject,
  normalizeEmail,
  oneOf,
  password,
  ROLES,
  str,
} from "@/server/validate"

type AccountSummaryRow = AccountRow & { member_count: number }

const ACCOUNT_SUMMARY = `a.*, (SELECT COUNT(*) FROM memberships WHERE account_id = a.id) AS member_count`

const toSummary = (row: AccountSummaryRow): AccountSummary => ({
  ...toAccount(row),
  memberCount: row.member_count,
})

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export async function listAccounts(ctx: Ctx, search: unknown = ""): Promise<AccountSummary[]> {
  await requireOperator(ctx)
  const q = str(search, 200).trim()
  const rows = await all<AccountSummaryRow>(
    ctx.db,
    `SELECT ${ACCOUNT_SUMMARY} FROM accounts a
     WHERE ? = '' OR a.name LIKE ? ESCAPE '\\'
     ORDER BY a.active DESC, a.name COLLATE NOCASE`,
    q,
    likePattern(q),
  )
  return rows.map(toSummary)
}

export async function getAccount(ctx: Ctx, id: unknown): Promise<AccountSummary> {
  await requireOperator(ctx)
  const row = await first<AccountSummaryRow>(
    ctx.db,
    `SELECT ${ACCOUNT_SUMMARY} FROM accounts a WHERE a.id = ?`,
    str(id, 100),
  )
  if (!row) throw new AppError("workspaceNotFound")
  return toSummary(row)
}

export async function createAccount(ctx: Ctx, input: unknown): Promise<Account> {
  await requireOperator(ctx)
  if (!isObject(input)) throw new AppError("badRequest")
  const name = str(input.name, 120).trim()
  if (!name) throw new AppError("nameRequired")
  const account: Account = {
    id: newId("acc"),
    name,
    active: true,
    createdAt: nowIso(),
    logoUrl: null,
  }
  await run(
    ctx.db,
    "INSERT INTO accounts (id, name, active, created_at) VALUES (?, ?, 1, ?)",
    account.id,
    account.name,
    account.createdAt,
  )
  return account
}

export async function updateAccount(ctx: Ctx, id: unknown, input: unknown): Promise<Account> {
  await requireOperator(ctx)
  if (!isObject(input)) throw new AppError("badRequest")
  const row = await first<AccountRow>(ctx.db, "SELECT * FROM accounts WHERE id = ?", str(id, 100))
  if (!row) throw new AppError("workspaceNotFound")
  const next = toAccount(row)
  if (input.name !== undefined) {
    next.name = str(input.name, 120).trim()
    if (!next.name) throw new AppError("nameRequired")
  }
  if (input.active !== undefined) next.active = bool(input.active)
  await run(
    ctx.db,
    "UPDATE accounts SET name = ?, active = ? WHERE id = ?",
    next.name,
    next.active ? 1 : 0,
    next.id,
  )
  return next
}

/**
 * Set or remove a workspace logo (operator-only). `logo` is `{ contentType,
 * data }` with base64 data, or null to go back to the default brand.
 */
export async function setAccountLogo(ctx: Ctx, accountId: unknown, logo: unknown): Promise<Account> {
  await requireOperator(ctx)
  const id = str(accountId, 100)
  const row = await first<AccountRow>(ctx.db, "SELECT * FROM accounts WHERE id = ?", id)
  if (!row) throw new AppError("workspaceNotFound")
  const now = nowIso()

  if (logo === null) {
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM account_logos WHERE account_id = ?").bind(id),
      ctx.db.prepare("UPDATE accounts SET logo_updated_at = NULL WHERE id = ?").bind(id),
    ])
    return toAccount({ ...row, logo_updated_at: null })
  }

  if (!isObject(logo)) throw new AppError("badRequest")
  const contentType = oneOf(logo.contentType, LOGO_TYPES)
  if (typeof logo.data !== "string") throw new AppError("badRequest")
  if (logo.data.length > Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 4) throw new AppError("logoTooLarge")
  const data = logo.data
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  } catch {
    throw new AppError("logoInvalid")
  }
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw new AppError("logoTooLarge")
  if (!looksLikeImage(contentType, bytes)) throw new AppError("logoInvalid")

  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO account_logos (account_id, content_type, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .bind(id, contentType, data, now),
    ctx.db.prepare("UPDATE accounts SET logo_updated_at = ? WHERE id = ?").bind(now, id),
  ])
  return toAccount({ ...row, logo_updated_at: now })
}

export async function listAccountMembers(ctx: Ctx, accountId: unknown): Promise<WorkspaceMember[]> {
  await requireOperator(ctx)
  return membersOf(ctx.db, str(accountId, 100))
}

export async function listAllUsers(ctx: Ctx, search: unknown = ""): Promise<UserSummary[]> {
  await requireOperator(ctx)
  const q = str(search, 200).trim()
  const users = await all<UserRow>(
    ctx.db,
    `SELECT * FROM users
     WHERE deleted_at IS NULL AND (? = '' OR name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
     ORDER BY is_operator DESC, active DESC, name COLLATE NOCASE`,
    q,
    likePattern(q),
    likePattern(q),
  )
  const memberships = await all<{
    id: string
    user_id: string
    account_id: string
    account_name: string
    role: Role
  }>(
    ctx.db,
    `SELECT ms.id, ms.user_id, ms.account_id, a.name AS account_name, ms.role
     FROM memberships ms JOIN accounts a ON a.id = ms.account_id
     ORDER BY a.name COLLATE NOCASE`,
  )
  return users.map((row) => ({
    ...toPublicUser(row),
    workspaces: memberships
      .filter((m) => m.user_id === row.id)
      .map((m) => ({
        membershipId: m.id,
        accountId: m.account_id,
        accountName: m.account_name,
        role: m.role,
      })),
  }))
}

export async function createUser(ctx: Ctx, input: unknown): Promise<PublicUser> {
  await requireOperator(ctx)
  if (!isObject(input)) throw new AppError("badRequest")
  const name = str(input.name, 100).trim()
  const email = normalizeEmail(str(input.email, 254))
  if (!name) throw new AppError("nameRequired")
  assertEmail(email)
  if (await first(ctx.db, "SELECT 1 FROM users WHERE email = ?", email)) {
    throw new AppError("emailTaken")
  }
  const hash = await hashPassword(password(input.password))
  const user: PublicUser = {
    id: newId("u"),
    name,
    email,
    isOperator: bool(input.isOperator),
    active: true,
    locale: "en",
    createdAt: nowIso(),
    avatarUrl: null,
    timeZone: null,
    calendarView: "calendar",
  }
  await run(
    ctx.db,
    `INSERT INTO users (id, name, email, password_hash, is_operator, active, locale, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 'en', ?)`,
    user.id,
    user.name,
    user.email,
    hash,
    user.isOperator ? 1 : 0,
    user.createdAt,
  )
  return user
}

export async function updateUser(ctx: Ctx, id: unknown, input: unknown): Promise<PublicUser> {
  const operator = await requireOperator(ctx)
  if (!isObject(input)) throw new AppError("badRequest")
  const userId = str(id, 100)
  const row = await first<UserRow>(
    ctx.db,
    "SELECT * FROM users WHERE id = ? AND deleted_at IS NULL",
    userId,
  )
  if (!row) throw new AppError("userNotFound")
  if (userId === operator.id && input.active === false) throw new AppError("selfDeactivate")
  if (userId === operator.id && input.isOperator === false) throw new AppError("selfDemote")
  const next = toPublicUser(row)
  if (input.name !== undefined) {
    next.name = str(input.name, 100).trim()
    if (!next.name) throw new AppError("nameRequired")
  }
  if (input.email !== undefined) {
    const email = normalizeEmail(str(input.email, 254))
    assertEmail(email)
    if (await first(ctx.db, "SELECT 1 FROM users WHERE email = ? AND id != ?", email, userId)) {
      throw new AppError("emailTaken")
    }
    next.email = email
  }
  if (input.active !== undefined) next.active = bool(input.active)
  if (input.isOperator !== undefined) next.isOperator = bool(input.isOperator)
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE users SET name = ?, email = ?, active = ?, is_operator = ? WHERE id = ?")
      .bind(next.name, next.email, next.active ? 1 : 0, next.isOperator ? 1 : 0, userId),
    // Deactivation signs the person out everywhere.
    ...(next.active ? [] : [ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId)]),
  ])
  // …and disconnects their Google account (removing the workspace copies there).
  if (row.active === 1 && !next.active) await enqueue(ctx, [{ kind: "purge_user", userId }])
  return next
}

export async function setUserPassword(ctx: Ctx, id: unknown, newPassword: unknown): Promise<void> {
  await requireOperator(ctx)
  const userId = str(id, 100)
  const hash = await hashPassword(password(newPassword))
  if (!(await first(ctx.db, "SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL", userId))) {
    throw new AppError("userNotFound")
  }
  await ctx.db.batch([
    ctx.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, userId),
    ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
  ])
}

/**
 * Delete a user: they lose every workspace, assignment and session and can no
 * longer sign in; their email is freed for reuse. The row stays, anonymized,
 * so tasks they created and meetings they organized keep a valid reference
 * (the UI shows no name for people outside the workspace).
 */
export async function deleteUser(ctx: Ctx, id: unknown): Promise<void> {
  const operator = await requireOperator(ctx)
  const userId = str(id, 100)
  if (userId === operator.id) throw new AppError("selfDelete")
  if (!(await first(ctx.db, "SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL", userId))) {
    throw new AppError("userNotFound")
  }
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM memberships WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM task_assignees WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM meeting_attendees WHERE user_id = ?").bind(userId),
    ctx.db
      .prepare(
        `UPDATE users SET name = 'Deleted user', email = 'deleted+' || id || '@deleted.invalid',
           password_hash = '!', is_operator = 0, active = 0, deleted_at = ?
         WHERE id = ?`,
      )
      .bind(nowIso(), userId),
  ])
  await enqueue(ctx, [{ kind: "purge_user", userId }])
}

/** Attach a user to an account (workspace) with a role. */
export async function attachUser(
  ctx: Ctx,
  accountId: unknown,
  userId: unknown,
  role: unknown,
): Promise<void> {
  const operator = await requireOperator(ctx)
  const account = str(accountId, 100)
  const user = str(userId, 100)
  const r = oneOf(role, ROLES)
  const accountRow = await first<{ name: string }>(ctx.db, "SELECT name FROM accounts WHERE id = ?", account)
  if (!accountRow) throw new AppError("workspaceNotFound")
  if (!(await first(ctx.db, "SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL", user))) {
    throw new AppError("userNotFound")
  }
  if (
    await first(
      ctx.db,
      "SELECT 1 FROM memberships WHERE account_id = ? AND user_id = ?",
      account,
      user,
    )
  ) {
    throw new AppError("alreadyMember")
  }
  await run(
    ctx.db,
    "INSERT INTO memberships (id, account_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
    newId("mb"),
    account,
    user,
    r,
    nowIso(),
  )
  await notify(ctx, {
    recipients: [user],
    actorId: operator.id,
    event: "workspace_added",
    accountId: account,
    data: { actor: operator.name, workspace: accountRow.name },
    link: `/w/${account}/dashboard`,
  })
  await enqueue(ctx, [{ kind: "setup_member", userId: user, accountId: account }])
}

export async function setMembershipRole(
  ctx: Ctx,
  membershipId: unknown,
  role: unknown,
): Promise<void> {
  await requireOperator(ctx)
  const id = str(membershipId, 100)
  if (!(await first(ctx.db, "SELECT 1 FROM memberships WHERE id = ?", id))) {
    throw new AppError("notFound")
  }
  await run(ctx.db, "UPDATE memberships SET role = ? WHERE id = ?", oneOf(role, ROLES), id)
}

export async function detachUser(ctx: Ctx, membershipId: unknown): Promise<void> {
  await requireOperator(ctx)
  const id = str(membershipId, 100)
  const membership = await first<{ user_id: string; account_id: string }>(
    ctx.db,
    "SELECT user_id, account_id FROM memberships WHERE id = ?",
    id,
  )
  await run(ctx.db, "DELETE FROM memberships WHERE id = ?", id)
  if (membership) {
    await enqueue(ctx, [
      { kind: "purge_member", userId: membership.user_id, accountId: membership.account_id },
    ])
  }
}
