/**
 * Sending email: one SMTP session per batch. Callers decide whether to wait
 * (an invitation the admin should hear about) or hand it to `ctx.waitUntil`
 * (notifications).
 */
import type { Ctx } from "@/server/context"
import { mailConfig } from "@/server/mail/config"
import type { Address } from "@/server/mail/mime"
import { sendMessages } from "@/server/mail/smtp"
import type { RenderedMail } from "@/server/mail/templates"
import { settingsOf } from "@/server/settings"

export type Outgoing = { to: Address; mail: RenderedMail; headers?: Record<string, string> }

export async function mailConfigured(ctx: Ctx): Promise<boolean> {
  return mailConfig(await settingsOf(ctx)) !== null
}

/**
 * Send `messages`. Returns how many were accepted by the mail server. Throws
 * only if email isn't configured or the server can't be reached or refuses
 * the login; a refused recipient is logged and skipped.
 */
export async function sendMail(ctx: Ctx, messages: Outgoing[]): Promise<number> {
  const config = mailConfig(await settingsOf(ctx))
  if (!config) throw new Error("Email isn't configured")
  const results = await sendMessages(
    config,
    messages.map(({ to, mail, headers }) => ({ from: config.from, to, ...mail, headers })),
  )
  results.forEach((error, i) => {
    if (error) console.error(`email to ${messages[i].to.email} failed: ${error.message}`)
  })
  return results.filter((error) => error === null).length
}
