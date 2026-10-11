/**
 * Your email addresses (Settings → Email addresses): one login for people
 * whose workspaces each know them by a different address. Extra addresses
 * are confirmed by an emailed link before they sign in, receive invitations
 * or can be chosen for a workspace.
 */
import { AppError } from "@/lib/api/core"
import type { Locale, MyEmails } from "@/lib/types"
import { requireUser, type Ctx } from "@/server/context"
import { hashToken, newSessionToken } from "@/server/crypto"
import { all, first, nowIso, run } from "@/server/db"
import { emailTaken } from "@/server/emails"
import { mailConfigured, sendMail } from "@/server/mail/send"
import { verifyEmailMail } from "@/server/mail/templates"
import { appOrigin, appUrl } from "@/server/settings"
import { assertEmail, normalizeEmail, str } from "@/server/validate"

const MAX_OTHER_EMAILS = 5
const VERIFY_MS = 24 * 3_600_000
/** Confirmation emails go to addresses people type: limit them so nobody can spam a stranger. */
const SEND_GAP_MS = 60_000
const SENDS_PER_DAY = 10

/** Throws `tooSoon` if this person may not send another confirmation email yet. */
async function assertCanSend(ctx: Ctx, userId: string): Promise<void> {
  const now = Date.now()
  const dayAgo = new Date(now - 86_400_000).toISOString()
  await run(ctx.db, "DELETE FROM email_confirmation_sends WHERE user_id = ? AND sent_at < ?", userId, dayAgo)
  const row = await first<{ n: number; last: string | null }>(
    ctx.db,
    "SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM email_confirmation_sends WHERE user_id = ?",
    userId,
  )
  const recent = row?.last && now - Date.parse(row.last) < SEND_GAP_MS
  if (recent || (row?.n ?? 0) >= SENDS_PER_DAY) throw new AppError("tooSoon")
}

type EmailRow = { email: string; verified_at: string | null }

export async function listMyEmails(ctx: Ctx): Promise<MyEmails> {
  const me = await requireUser(ctx)
  const [rows, workspaces] = await Promise.all([
    all<EmailRow>(
      ctx.db,
      "SELECT email, verified_at FROM user_emails WHERE user_id = ? ORDER BY created_at",
      me.id,
    ),
    all<{ account_id: string; name: string; email: string | null }>(
      ctx.db,
      `SELECT ms.account_id, a.name, ms.email FROM memberships ms
       JOIN accounts a ON a.id = ms.account_id AND a.active = 1
       WHERE ms.user_id = ? ORDER BY a.name COLLATE NOCASE`,
      me.id,
    ),
  ])
  return {
    primary: me.email,
    others: rows.map((row) => ({
      email: row.email,
      confirmed: row.verified_at !== null,
      workspaces: workspaces.filter((w) => w.email === row.email).map((w) => w.name),
    })),
    workspaces: workspaces.map((w) => ({
      accountId: w.account_id,
      name: w.name,
      email: w.email ?? me.email,
    })),
  }
}

/** Email a fresh confirmation link for one of my unconfirmed addresses. */
async function sendConfirmation(
  ctx: Ctx,
  me: { id: string; name: string; locale: Locale },
  email: string,
): Promise<void> {
  await assertCanSend(ctx, me.id)
  const token = newSessionToken()
  await ctx.db.batch([
    ctx.db
      .prepare(
        "UPDATE user_emails SET token_hash = ?, token_expires_at = ? WHERE user_id = ? AND email = ?",
      )
      .bind(await hashToken(token), new Date(Date.now() + VERIFY_MS).toISOString(), me.id, email),
    ctx.db
      .prepare("INSERT INTO email_confirmation_sends (user_id, sent_at) VALUES (?, ?)")
      .bind(me.id, nowIso()),
  ])
  const sent = await sendMail(ctx, [
    {
      to: { name: me.name, email },
      mail: verifyEmailMail(me.locale, {
        name: me.name,
        email,
        url: await appUrl(ctx, `/verify-email?token=${token}`),
        origin: await appOrigin(ctx),
      }),
    },
  ]).catch(() => 0)
  if (sent === 0) throw new AppError("mailFailed")
}

/** Add another address; it works once they click the link sent to it. */
export async function addMyEmail(ctx: Ctx, raw: unknown): Promise<MyEmails> {
  const me = await requireUser(ctx)
  const email = normalizeEmail(str(raw, 254))
  assertEmail(email)
  if (!(await mailConfigured(ctx))) throw new AppError("mailNotConfigured")
  if (email === me.email) throw new AppError("emailTaken")
  if (await emailTaken(ctx.db, email, me.id)) throw new AppError("emailTaken")
  const count = await first<{ n: number }>(
    ctx.db,
    "SELECT COUNT(*) AS n FROM user_emails WHERE user_id = ?",
    me.id,
  )
  const existing = await first<EmailRow>(
    ctx.db,
    "SELECT email, verified_at FROM user_emails WHERE user_id = ? AND email = ?",
    me.id,
    email,
  )
  if (existing?.verified_at) throw new AppError("emailTaken")
  await assertCanSend(ctx, me.id)
  if (!existing) {
    if ((count?.n ?? 0) >= MAX_OTHER_EMAILS) throw new AppError("tooManyEmails")
    await run(
      ctx.db,
      "INSERT INTO user_emails (user_id, email, created_at) VALUES (?, ?, ?)",
      me.id,
      email,
      nowIso(),
    )
  }
  await sendConfirmation(ctx, me, email)
  return listMyEmails(ctx)
}

export async function resendEmailConfirmation(ctx: Ctx, raw: unknown): Promise<void> {
  const me = await requireUser(ctx)
  const email = normalizeEmail(str(raw, 254))
  const row = await first<EmailRow>(
    ctx.db,
    "SELECT email, verified_at FROM user_emails WHERE user_id = ? AND email = ?",
    me.id,
    email,
  )
  if (!row || row.verified_at) throw new AppError("badRequest")
  if (!(await mailConfigured(ctx))) throw new AppError("mailNotConfigured")
  await sendConfirmation(ctx, me, email)
}

/**
 * The link from the confirmation email. Works without being signed in (it may
 * be opened on another device); the token alone proves the inbox is theirs.
 */
export async function confirmEmail(ctx: Ctx, token: unknown): Promise<{ email: string }> {
  const row = await first<{ user_id: string; email: string }>(
    ctx.db,
    `SELECT ue.user_id, ue.email FROM user_emails ue JOIN users u ON u.id = ue.user_id
     WHERE ue.token_hash = ? AND ue.token_expires_at > ? AND u.deleted_at IS NULL`,
    await hashToken(str(token, 200)),
    nowIso(),
  )
  if (!row) throw new AppError("verifyInvalid")
  // Someone else confirmed it (or made it theirs) since it was added.
  if (await emailTaken(ctx.db, row.email, row.user_id)) {
    await run(ctx.db, "DELETE FROM user_emails WHERE user_id = ? AND email = ?", row.user_id, row.email)
    throw new AppError("emailTaken")
  }
  try {
    await run(
      ctx.db,
      `UPDATE user_emails SET verified_at = ?, token_hash = NULL, token_expires_at = NULL
       WHERE user_id = ? AND email = ?`,
      nowIso(),
      row.user_id,
      row.email,
    )
  } catch (error) {
    // Someone confirmed the same address a moment earlier (unique index).
    if (/UNIQUE/i.test(String(error))) throw new AppError("emailTaken")
    throw error
  }
  return { email: row.email }
}

/** Remove one of my other addresses; workspaces using it go back to my primary. */
export async function removeMyEmail(ctx: Ctx, raw: unknown): Promise<MyEmails> {
  const me = await requireUser(ctx)
  const email = normalizeEmail(str(raw, 254))
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM user_emails WHERE user_id = ? AND email = ?").bind(me.id, email),
    ctx.db
      .prepare("UPDATE memberships SET email = NULL WHERE user_id = ? AND email = ?")
      .bind(me.id, email),
    // An invitation sent to it would otherwise attach it when accepted.
    ctx.db
      .prepare("UPDATE workspace_invitations SET email = NULL WHERE user_id = ? AND email = ?")
      .bind(me.id, email),
  ])
  return listMyEmails(ctx)
}

/**
 * Swap a confirmed address in as my primary; the old primary stays as a
 * confirmed other address. Workspaces that followed the primary keep the
 * address they knew, so nobody suddenly sees a different one.
 */
export async function makeEmailPrimary(ctx: Ctx, raw: unknown): Promise<MyEmails> {
  const me = await requireUser(ctx)
  const email = normalizeEmail(str(raw, 254))
  const row = await first<EmailRow>(
    ctx.db,
    "SELECT email, verified_at FROM user_emails WHERE user_id = ? AND email = ?",
    me.id,
    email,
  )
  if (!row?.verified_at) throw new AppError("badRequest")
  const now = nowIso()
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE memberships SET email = ? WHERE user_id = ? AND email IS NULL")
      .bind(me.email, me.id),
    // Pending invitations too: the inviting workspace keeps seeing the address it used.
    ctx.db
      .prepare("UPDATE workspace_invitations SET email = ? WHERE user_id = ? AND email IS NULL")
      .bind(me.email, me.id),
    ctx.db
      .prepare("UPDATE workspace_invitations SET email = NULL WHERE user_id = ? AND email = ?")
      .bind(me.id, email),
    // Workspaces that knew me by the new primary simply follow it now.
    ctx.db
      .prepare("UPDATE memberships SET email = NULL WHERE user_id = ? AND email = ?")
      .bind(me.id, email),
    ctx.db.prepare("DELETE FROM user_emails WHERE user_id = ? AND email = ?").bind(me.id, email),
    ctx.db.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, me.id),
    ctx.db
      .prepare(
        "INSERT INTO user_emails (user_id, email, verified_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(me.id, me.email, now, now),
  ])
  ctx.user = undefined
  return listMyEmails(ctx)
}

/** Choose which of my confirmed addresses a workspace knows me by. */
export async function setWorkspaceEmail(
  ctx: Ctx,
  accountId: unknown,
  raw: unknown,
): Promise<MyEmails> {
  const me = await requireUser(ctx)
  const id = str(accountId, 100)
  const email = normalizeEmail(str(raw, 254))
  if (email !== me.email) {
    const row = await first<EmailRow>(
      ctx.db,
      "SELECT email, verified_at FROM user_emails WHERE user_id = ? AND email = ?",
      me.id,
      email,
    )
    if (!row?.verified_at) throw new AppError("badRequest")
  }
  const result = await ctx.db
    .prepare("UPDATE memberships SET email = ? WHERE user_id = ? AND account_id = ?")
    .bind(email === me.email ? null : email, me.id, id)
    .run()
  if (!result.meta.changes) throw new AppError("workspaceNotFound")
  return listMyEmails(ctx)
}
