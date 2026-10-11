/**
 * Email (SMTP) settings, from Platform → Settings or the environment
 * (`server/settings.ts`). Without them invitations fall back to a temporary
 * password and email notifications can't be switched on.
 */
import type { Address } from "@/server/mail/mime"
import type { SmtpConfig } from "@/server/mail/smtp"
import type { ResolvedSettings } from "@/server/settings"

export type MailConfig = SmtpConfig & { from: Address }

/** `Name <address>` or a bare address. */
export function parseFrom(value: string, fallback: string): Address {
  const match = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value)
  if (match) return { name: match[1].replace(/^"|"$/g, "") || undefined, email: match[2] }
  return { email: value.trim() || fallback }
}

export function mailConfig({ values }: ResolvedSettings): MailConfig | null {
  const host = values.smtp_host
  const user = values.smtp_user
  if (!host || !user || !values.smtp_pass) return null
  const port = Number(values.smtp_port) || 465
  return {
    host,
    port,
    // Implicit TLS unless told otherwise (only the local mock runs without it).
    secure: values.smtp_secure ? values.smtp_secure !== "false" : port === 465,
    user,
    pass: values.smtp_pass,
    from: parseFrom(values.mail_from ?? "", user),
  }
}
