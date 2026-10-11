import { AppError } from "@/lib/api/core"
import {
  AVATAR_TYPES,
  CALENDAR_PREFERENCES,
  MAX_AVATAR_BYTES,
  type MyWorkspace,
  type PublicUser,
  type Role,
} from "@/lib/types"
import { currentUser, endSession, requireUser, startSession, type Ctx } from "@/server/context"
import { hashPassword, hashToken, verifyPassword } from "@/server/crypto"
import {
  all,
  avatarUrl,
  first,
  nowIso,
  run,
  toAccount,
  toUser,
  type AccountRow,
} from "@/server/db"
import { userByEmail } from "@/server/emails"
import { decodeBase64, looksLikeImage } from "@/server/images"
import {
  isObject,
  LOCALES,
  normalizeEmail,
  oneOf,
  optStr,
  password,
  str,
  timeZone as validTimeZone,
} from "@/server/validate"

const toPublic = ({ passwordHash: _hash, ...user }: PublicUser & { passwordHash: string }) => {
  void _hash
  return user
}

// Verified when the email is unknown, so a miss takes as long as a hit.
const DUMMY_HASH =
  "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

/** Sign-in throttling: failures allowed per email and per network address in the window. */
const FAILURE_WINDOW_MS = 15 * 60_000
const FAILURES_PER_EMAIL = 5
const FAILURES_PER_IP = 30

export async function login(ctx: Ctx, email: unknown, pass: unknown): Promise<PublicUser> {
  const normalized = normalizeEmail(str(email, 254))
  const keys = { email: `email:${normalized}`, ip: `ip:${ctx.ip ?? "unknown"}` }
  const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString()
  // Checked before the password, and the same whether or not the account exists.
  const recent = await first<{ by_email: number; by_ip: number }>(
    ctx.db,
    `SELECT SUM(key = ?) AS by_email, SUM(key = ?) AS by_ip FROM login_failures
     WHERE key IN (?, ?) AND failed_at > ?`,
    keys.email,
    keys.ip,
    keys.email,
    keys.ip,
    since,
  )
  if ((recent?.by_email ?? 0) >= FAILURES_PER_EMAIL || (recent?.by_ip ?? 0) >= FAILURES_PER_IP) {
    throw new AppError("tooManyAttempts")
  }
  // Any of their confirmed addresses signs them in.
  const row = await userByEmail(ctx.db, normalized)
  const ok = await verifyPassword(str(pass, 200), row?.password_hash ?? DUMMY_HASH)
  if (!row || !ok) {
    const now = nowIso()
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM login_failures WHERE failed_at <= ?").bind(since),
      ctx.db
        .prepare("INSERT INTO login_failures (key, failed_at) VALUES (?, ?), (?, ?)")
        .bind(keys.email, now, keys.ip, now),
    ])
    throw new AppError("invalidCredentials")
  }
  // Signed in: this address starts afresh.
  await run(ctx.db, "DELETE FROM login_failures WHERE key = ?", keys.email)
  const user = toUser(row)
  if (!user.active) throw new AppError("accountDisabled")
  await startSession(ctx, user.id)
  return toPublic(user)
}

export async function logout(ctx: Ctx): Promise<void> {
  await endSession(ctx)
}

/** The current session's user, or null when signed out / deactivated. */
export async function getMe(ctx: Ctx): Promise<PublicUser | null> {
  const user = await currentUser(ctx)
  if (!user && ctx.token) ctx.clearSessionCookie()
  return user ? toPublic(user) : null
}

export async function updateMe(ctx: Ctx, input: unknown): Promise<PublicUser> {
  const me = await requireUser(ctx)
  const v = (input ?? {}) as Record<string, unknown>
  const rawName = optStr(v.name, 100)
  const name = rawName?.trim()
  if (rawName !== undefined && !name) throw new AppError("nameRequired")
  const locale = v.locale === undefined ? undefined : oneOf(v.locale, LOCALES)
  const timeZone = v.timeZone === undefined ? undefined : validTimeZone(v.timeZone)
  const calendarView =
    v.calendarView === undefined ? undefined : oneOf(v.calendarView, CALENDAR_PREFERENCES)
  await run(
    ctx.db,
    "UPDATE users SET name = ?, locale = ?, timezone = ?, calendar_view = ? WHERE id = ?",
    name ?? me.name,
    locale ?? me.locale,
    timeZone ?? me.timeZone,
    calendarView ?? me.calendarView,
    me.id,
  )
  return toPublic({
    ...me,
    name: name ?? me.name,
    locale: locale ?? me.locale,
    timeZone: timeZone ?? me.timeZone,
    calendarView: calendarView ?? me.calendarView,
  })
}

/** Change your own password; every other session of yours is signed out. */
export async function changePassword(ctx: Ctx, current: unknown, next: unknown): Promise<void> {
  const me = await requireUser(ctx)
  if (!(await verifyPassword(str(current, 200), me.passwordHash))) {
    throw new AppError("wrongPassword")
  }
  const hash = await hashPassword(password(next))
  await ctx.db.batch([
    ctx.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, me.id),
    ctx.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .bind(me.id, ctx.token ? await hashToken(ctx.token) : ""),
  ])
}

/**
 * Workspaces the signed-in user can open. Operators see every account
 * (acting as Administrator unless they are a member themselves).
 */
export async function listMyWorkspaces(ctx: Ctx): Promise<MyWorkspace[]> {
  const me = await requireUser(ctx)
  const rows = await all<AccountRow & { role: Role | null }>(
    ctx.db,
    `SELECT a.*, ms.role FROM accounts a
     LEFT JOIN memberships ms ON ms.account_id = a.id AND ms.user_id = ?
     WHERE ms.id IS NOT NULL OR ?
     ORDER BY a.name COLLATE NOCASE`,
    me.id,
    me.isOperator ? 1 : 0,
  )
  return rows.flatMap((row): MyWorkspace[] => {
    const account = toAccount(row)
    if (row.role && (account.active || me.isOperator)) {
      return [{ account, role: row.role, viaOperator: false }]
    }
    if (me.isOperator) return [{ account, role: "administrator", viaOperator: true }]
    return []
  })
}

/** Set (base64 square image, resized by the browser) or remove (null) your photo. */
export async function setMyAvatar(ctx: Ctx, photo: unknown): Promise<PublicUser> {
  const me = await requireUser(ctx)
  const now = nowIso()
  if (photo === null) {
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM user_avatars WHERE user_id = ?").bind(me.id),
      ctx.db.prepare("UPDATE users SET avatar_updated_at = NULL WHERE id = ?").bind(me.id),
    ])
    return toPublic({ ...me, avatarUrl: null })
  }
  if (!isObject(photo) || typeof photo.data !== "string") throw new AppError("badRequest")
  const contentType = oneOf(photo.contentType, AVATAR_TYPES)
  if (photo.data.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4) {
    throw new AppError("avatarTooLarge")
  }
  const bytes = decodeBase64(photo.data)
  if (!bytes || bytes.length === 0 || !looksLikeImage(contentType, bytes)) {
    throw new AppError("avatarInvalid")
  }
  if (bytes.length > MAX_AVATAR_BYTES) throw new AppError("avatarTooLarge")
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO user_avatars (user_id, content_type, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .bind(me.id, contentType, photo.data, now),
    ctx.db.prepare("UPDATE users SET avatar_updated_at = ? WHERE id = ?").bind(now, me.id),
  ])
  return toPublic({ ...me, avatarUrl: avatarUrl(me.id, now) })
}
