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
import { hashPassword, newId, newSessionToken } from "@/server/crypto"
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
import { emailTaken } from "@/server/emails"
import { enqueue, queueMeetingResync } from "@/server/google/queue"
import { looksLikeImage } from "@/server/images"
import { revokeLiveTokensStatement } from "@/server/live/tokens"
import { revokeAllGrants } from "@/server/mcp/grants"
import { mailConfigured } from "@/server/mail/send"
import { membersOf } from "@/server/services/members"
import { notify } from "@/server/services/notifications"
import { sendInvitation, type Inviter } from "@/server/services/password-links"
import {
  assertEmail,
  bool,
  isObject,
  normalizeEmail,
  oneOf,
  password,
  ROLES,
  str,
  timeZone,
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
    timeZone: null,
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
  // "" or null: no workspace zone (each organiser's own).
  if (input.timeZone !== undefined) {
    next.timeZone = input.timeZone === null || input.timeZone === "" ? null : timeZone(input.timeZone)
  }
  await run(
    ctx.db,
    "UPDATE accounts SET name = ?, active = ?, timezone = ? WHERE id = ?",
    next.name,
    next.active ? 1 : 0,
    next.timeZone,
    next.id,
  )
  // Meeting times now mean a different zone: rewrite them on every Google copy.
  if (next.timeZone !== row.timezone) await queueMeetingResync(ctx, next.id)
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
    // Any of their addresses finds them, not only the primary.
    `SELECT * FROM users
     WHERE deleted_at IS NULL AND (? = '' OR name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
       OR id IN (SELECT user_id FROM user_emails WHERE verified_at IS NOT NULL AND email LIKE ? ESCAPE '\\'))
     ORDER BY is_operator DESC, active DESC, name COLLATE NOCASE`,
    q,
    likePattern(q),
    likePattern(q),
    likePattern(q),
  )
  const others = await all<{ user_id: string; email: string }>(
    ctx.db,
    `SELECT user_id, email FROM user_emails
     WHERE verified_at IS NOT NULL AND user_id IN (SELECT value FROM json_each(?))
     ORDER BY created_at`,
    JSON.stringify(users.map((u) => u.id)),
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
    otherEmails: others.filter((o) => o.user_id === row.id).map((o) => o.email),
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

/**
 * Create a user (operator-only). With `invite`, they get an email to choose
 * their own password (needs email set up); otherwise the operator sets one.
 * `invited` is false if the invitation couldn't be sent: the account exists,
 * and the operator can resend it or set a password.
 */
export async function createUser(
  ctx: Ctx,
  input: unknown,
): Promise<PublicUser & { invited: boolean }> {
  const operator = await requireOperator(ctx)
  if (!isObject(input)) throw new AppError("badRequest")
  const name = str(input.name, 100).trim()
  const email = normalizeEmail(str(input.email, 254))
  const invite = input.invite === undefined ? false : bool(input.invite)
  if (!name) throw new AppError("nameRequired")
  assertEmail(email)
  if (await emailTaken(ctx.db, email)) throw new AppError("emailTaken")
  if (invite && !(await mailConfigured(ctx))) throw new AppError("mailNotConfigured")
  // Invited: a random password nobody knows until they choose their own.
  const hash = await hashPassword(invite ? newSessionToken() : password(input.password))
  const user: PublicUser = {
    id: newId("u"),
    name,
    email,
    isOperator: bool(input.isOperator),
    active: true,
    locale: operator.locale,
    createdAt: nowIso(),
    avatarUrl: null,
    timeZone: null,
    calendarView: "calendar",
    invitePending: invite,
  }
  await run(
    ctx.db,
    `INSERT INTO users (id, name, email, password_hash, is_operator, active, locale, invited_at, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    user.id,
    user.name,
    user.email,
    hash,
    user.isOperator ? 1 : 0,
    user.locale,
    invite ? user.createdAt : null,
    user.createdAt,
  )
  let invited = false
  if (invite) {
    invited = await sendInvitation(ctx, platformInviter(operator), user.id).then(
      () => true,
      () => false,
    )
  }
  return { ...user, invited }
}

/** Email a new password link to someone who hasn't accepted their invitation yet. */
export async function resendUserInvite(ctx: Ctx, id: unknown): Promise<void> {
  const operator = await requireOperator(ctx)
  const row = await first<UserRow>(
    ctx.db,
    "SELECT * FROM users WHERE id = ? AND deleted_at IS NULL",
    str(id, 100),
  )
  if (!row) throw new AppError("userNotFound")
  if (row.invited_at === null) throw new AppError("badRequest")
  if (!(await mailConfigured(ctx))) throw new AppError("mailNotConfigured")
  await sendInvitation(ctx, platformInviter(operator), row.id)
}

const platformInviter = (operator: PublicUser): Inviter => ({
  name: operator.name,
  locale: operator.locale,
  workspace: null,
})

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
    if (await emailTaken(ctx.db, email, userId)) {
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
    // If the new primary was one of their other addresses, it isn't "other" any more.
    ctx.db.prepare("DELETE FROM user_emails WHERE user_id = ? AND email = ?").bind(userId, next.email),
    // Deactivation signs the person out everywhere, recording devices included.
    ...(next.active
      ? []
      : [
          ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
          revokeLiveTokensStatement(ctx.db, userId),
        ]),
  ])
  // …disconnects their Google account (removing the workspace copies there),
  // and ends their Claude connections.
  if (row.active === 1 && !next.active) {
    await enqueue(ctx, [{ kind: "purge_user", userId }])
    await revokeAllGrants(ctx, userId)
  }
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
    // A password set by the operator also settles a pending invitation.
    ctx.db
      .prepare("UPDATE users SET password_hash = ?, invited_at = NULL WHERE id = ?")
      .bind(hash, userId),
    ctx.db.prepare("DELETE FROM password_tokens WHERE user_id = ?").bind(userId),
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
    revokeLiveTokensStatement(ctx.db, userId),
    ctx.db.prepare("DELETE FROM user_emails WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM task_assignees WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM meeting_attendees WHERE user_id = ?").bind(userId),
    // Minutes nobody else can read go with them; shared ones stay.
    ctx.db
      .prepare("DELETE FROM meeting_minutes WHERE author_id = ? AND visibility = 'private'")
      .bind(userId),
    ctx.db.prepare("DELETE FROM meeting_minutes_shares WHERE user_id = ?").bind(userId),
    ctx.db
      .prepare(
        `UPDATE users SET name = 'Deleted user', email = 'deleted+' || id || '@deleted.invalid',
           password_hash = '!', is_operator = 0, active = 0, deleted_at = ?
         WHERE id = ?`,
      )
      .bind(nowIso(), userId),
  ])
  await enqueue(ctx, [{ kind: "purge_user", userId }])
  await revokeAllGrants(ctx, userId)
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
    await revokeLiveTokensStatement(ctx.db, membership.user_id, membership.account_id).run()
    await enqueue(ctx, [
      { kind: "purge_member", userId: membership.user_id, accountId: membership.account_id },
    ])
  }
}
