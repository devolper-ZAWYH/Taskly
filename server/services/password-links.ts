/**
 * One-time links to choose a password, sent by email:
 *
 * - **Invitations**: someone added to a workspace by email gets a link to set
 *   their password (no temporary password changes hands). Valid 7 days.
 * - **Password resets** ("Forgot password?"): valid 1 hour. Asking never says
 *   whether the email has an account, and resetting signs out every session.
 *
 * Only a hash of each token is stored; a link works once, and a new link of
 * the same kind replaces the old one.
 */
import { AppError } from "@/lib/api/core"
import type { Locale, PublicUser } from "@/lib/types"
import { startSession, type Actor, type Ctx } from "@/server/context"
import { hashPassword, hashToken, newSessionToken } from "@/server/crypto"
import { first, nowIso, toPublicUser, type UserRow } from "@/server/db"
import { HAS_EMAIL } from "@/server/emails"
import { mailConfigured, sendMail } from "@/server/mail/send"
import { invitationMail, passwordResetMail } from "@/server/mail/templates"
import { appOrigin, appUrl } from "@/server/settings"
import { assertEmail, normalizeEmail, password, str } from "@/server/validate"

type Purpose = "invite" | "reset"

const LIFETIME_MS: Record<Purpose, number> = {
  invite: 7 * 86_400_000,
  reset: 60 * 60_000,
}
const PAGE: Record<Purpose, string> = { invite: "/invite", reset: "/reset-password" }
/** A second reset email within this window is silently skipped. */
const RESET_COOLDOWN_MS = 60_000

/** A new link of this kind for `userId` (an earlier one stops working). */
async function newLink(ctx: Ctx, userId: string, purpose: Purpose): Promise<string> {
  const token = newSessionToken()
  const now = new Date()
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM password_tokens WHERE user_id = ? AND purpose = ?")
      .bind(userId, purpose),
    ctx.db
      .prepare(
        `INSERT INTO password_tokens (token_hash, user_id, purpose, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        await hashToken(token),
        userId,
        purpose,
        new Date(now.getTime() + LIFETIME_MS[purpose]).toISOString(),
        now.toISOString(),
      ),
  ])
  return appUrl(ctx, `${PAGE[purpose]}?token=${token}`)
}

/** The active person a still-valid link belongs to. */
async function holderOf(
  ctx: Ctx,
  token: unknown,
  purpose: Purpose,
): Promise<UserRow & { token_hash: string }> {
  const row = await first<UserRow & { token_hash: string }>(
    ctx.db,
    `SELECT u.*, pt.token_hash FROM password_tokens pt JOIN users u ON u.id = pt.user_id
     WHERE pt.token_hash = ? AND pt.purpose = ? AND pt.expires_at > ?
       AND u.active = 1 AND u.deleted_at IS NULL`,
    await hashToken(str(token, 200)),
    purpose,
    nowIso(),
  )
  if (!row) throw new AppError(purpose === "invite" ? "inviteInvalid" : "resetInvalid")
  return row
}

/**
 * Set the password from a link, use up every link they have, sign out their
 * other sessions, and sign them in here.
 */
async function setPasswordFromLink(
  ctx: Ctx,
  token: unknown,
  purpose: Purpose,
  newPassword: unknown,
): Promise<PublicUser> {
  const user = await holderOf(ctx, token, purpose)
  const hash = await hashPassword(password(newPassword))
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE users SET password_hash = ?, invited_at = NULL WHERE id = ?")
      .bind(hash, user.id),
    ctx.db.prepare("DELETE FROM password_tokens WHERE user_id = ?").bind(user.id),
    ctx.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ])
  await startSession(ctx, user.id)
  return toPublicUser({ ...user, invited_at: null })
}

// ---- Invitations -----------------------------------------------------------------

/** Who an invitation comes from: their name and language, and the workspace if any. */
export type Inviter = { name: string; locale: Locale; workspace: string | null }

/** A workspace administrator inviting someone into their workspace. */
export const workspaceInviter = (actor: Actor): Inviter => ({
  name: actor.user.name,
  locale: actor.user.locale,
  workspace: actor.account.name,
})

/**
 * Email `userId` an invitation to set their password, in the inviter's
 * language. Waits for the mail server, so the inviter hears if it failed.
 */
export async function sendInvitation(ctx: Ctx, inviter: Inviter, userId: string): Promise<void> {
  const user = await first<{ name: string; email: string }>(
    ctx.db,
    "SELECT name, email FROM users WHERE id = ?",
    userId,
  )
  if (!user) throw new AppError("userNotFound")
  const url = await newLink(ctx, userId, "invite")
  let sent = 0
  try {
    sent = await sendMail(ctx, [
      {
        to: { name: user.name, email: user.email },
        mail: invitationMail(inviter.locale, {
          name: user.name,
          actor: inviter.name,
          workspace: inviter.workspace,
          url,
          origin: await appOrigin(ctx),
        }),
      },
    ])
  } catch (error) {
    console.error("invitation email failed", error)
  }
  if (sent === 0) throw new AppError("mailFailed")
}

/** Who the invitation page is for (it shows their name and email). */
export async function getInvite(ctx: Ctx, token: unknown): Promise<{ name: string; email: string }> {
  const user = await holderOf(ctx, token, "invite")
  return { name: user.name, email: user.email }
}

export function acceptInvite(ctx: Ctx, token: unknown, newPassword: unknown): Promise<PublicUser> {
  return setPasswordFromLink(ctx, token, "invite", newPassword)
}

// ---- Password resets ---------------------------------------------------------------

/**
 * "Forgot password?": email a reset link if `email` belongs to an active
 * account. Answers the same either way, and sends after the response, so
 * neither the reply nor its timing tells whether the account exists.
 */
export async function requestPasswordReset(ctx: Ctx, rawEmail: unknown): Promise<void> {
  if (!(await mailConfigured(ctx))) throw new AppError("mailNotConfigured")
  const email = normalizeEmail(str(rawEmail, 254))
  assertEmail(email)
  ctx.waitUntil(
    sendReset(ctx, email).catch((error) => console.error("password reset email failed", error)),
  )
}

async function sendReset(ctx: Ctx, email: string): Promise<void> {
  const user = await first<{ id: string; name: string; email: string; locale: string; recent: string | null }>(
    ctx.db,
    `SELECT u.id, u.name, u.email, u.locale,
       (SELECT MAX(created_at) FROM password_tokens WHERE user_id = u.id AND purpose = 'reset') AS recent
     FROM users u WHERE ${HAS_EMAIL} AND u.active = 1 AND u.deleted_at IS NULL`,
    email,
    email,
  )
  if (!user) return
  // One email a minute is plenty; repeated clicks shouldn't flood their inbox.
  if (user.recent && Date.now() - Date.parse(user.recent) < RESET_COOLDOWN_MS) return
  const url = await newLink(ctx, user.id, "reset")
  const locale: Locale = user.locale === "ar" ? "ar" : "en"
  // To the address they typed: it's theirs (confirmed), and the one they can read now.
  await sendMail(ctx, [
    {
      to: { name: user.name, email },
      mail: passwordResetMail(locale, {
        name: user.name,
        email,
        url,
        origin: await appOrigin(ctx),
      }),
    },
  ])
}

/** Whose password the reset page is for. */
export async function getPasswordReset(ctx: Ctx, token: unknown): Promise<{ name: string; email: string }> {
  const user = await holderOf(ctx, token, "reset")
  return { name: user.name, email: user.email }
}

export function resetPassword(ctx: Ctx, token: unknown, newPassword: unknown): Promise<PublicUser> {
  return setPasswordFromLink(ctx, token, "reset", newPassword)
}
