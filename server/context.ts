/**
 * Per-request context: the database, the session cookie, and the access checks
 * every service starts with (signed in → member of the workspace → role).
 */
import { AppError } from "@/lib/api/core"
import type { Account, Role, User } from "@/lib/types"
import { hashToken, newSessionToken } from "@/server/crypto"
import { first, nowIso, run, toAccount, toUser, type AccountRow, type UserRow } from "@/server/db"

export const SESSION_COOKIE = "session"
export const SESSION_DAYS = 30

export type Ctx = {
  db: D1Database
  /** Raw session token from the cookie, if any. */
  token: string | null
  setSessionCookie: (token: string, expires: Date) => void
  clearSessionCookie: () => void
  /** Run work after the response is sent (e.g. push delivery). */
  waitUntil: (promise: Promise<unknown>) => void
  env: CloudflareEnv
  /** Memoized `requireUser` result for this request. */
  user?: User & { passwordHash: string }
}

/** Start a session for `userId` and hand its token to the cookie. */
export async function startSession(ctx: Ctx, userId: string): Promise<void> {
  const token = newSessionToken()
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  const now = nowIso()
  await ctx.db.batch([
    // Housekeeping: drop this user's expired sessions as a new one starts.
    ctx.db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, now),
    ctx.db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await hashToken(token), userId, expires.toISOString(), now),
  ])
  ctx.setSessionCookie(token, expires)
}

export async function endSession(ctx: Ctx): Promise<void> {
  if (ctx.token) {
    await run(ctx.db, "DELETE FROM sessions WHERE token_hash = ?", await hashToken(ctx.token))
  }
  ctx.clearSessionCookie()
}

/** The signed-in user, or null (no/expired session, or deactivated). */
export async function currentUser(ctx: Ctx): Promise<(User & { passwordHash: string }) | null> {
  if (ctx.user) return ctx.user
  if (!ctx.token) return null
  const row = await first<UserRow>(
    ctx.db,
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    await hashToken(ctx.token),
    nowIso(),
  )
  if (!row) return null
  ctx.user = toUser(row)
  return ctx.user
}

export async function requireUser(ctx: Ctx): Promise<User & { passwordHash: string }> {
  const user = await currentUser(ctx)
  if (!user) throw new AppError("unauthorized")
  return user
}

/** The signed-in user acting inside one workspace, with their role there. */
export type Actor = { id: string; role: Role; user: User; account: Account }

/** Resolve the caller for a workspace-scoped call. Operators act as Administrators. */
export async function requireWorkspace(ctx: Ctx, accountId: unknown): Promise<Actor> {
  if (typeof accountId !== "string") throw new AppError("badRequest")
  const user = await requireUser(ctx)
  const row = await first<AccountRow & { role: Role | null }>(
    ctx.db,
    `SELECT a.*, ms.role FROM accounts a
     LEFT JOIN memberships ms ON ms.account_id = a.id AND ms.user_id = ?
     WHERE a.id = ?`,
    user.id,
    accountId,
  )
  if (!row) throw new AppError("workspaceNotFound")
  const account = toAccount(row)
  if (user.isOperator) return { id: user.id, role: "administrator", user, account }
  if (!row.role) throw new AppError("workspaceNotFound")
  if (!account.active) throw new AppError("workspaceInactive")
  return { id: user.id, role: row.role, user, account }
}

export async function requireWorkspaceAdmin(ctx: Ctx, accountId: unknown): Promise<Actor> {
  const actor = await requireWorkspace(ctx, accountId)
  if (actor.role !== "administrator") throw new AppError("forbidden")
  return actor
}

export async function requireOperator(ctx: Ctx): Promise<User> {
  const user = await requireUser(ctx)
  if (!user.isOperator) throw new AppError("forbidden")
  return user
}
