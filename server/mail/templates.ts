/**
 * Email bodies. Every email carries both English and Arabic: the recipient's
 * language first, then the other, under a Taskly header, with one button
 * (labelled in both) below them. Subjects carry both too. Each email has a plain-text and an
 * HTML part; the HTML is a single centred card with inline styles, which is
 * what mail clients render reliably.
 */
import type { Locale, Role } from "@/lib/types"
import ar from "@/messages/ar"
import en from "@/messages/en"

const DICTIONARIES = { en, ar }
const LOCALES: Locale[] = ["en", "ar"]

const GOLD = "#da9100"
const INK = "#1c1a17"
const MUTED = "#6b665e"
const LINE = "#efebe3"
const FONT = "-apple-system,'Segoe UI',Tahoma,Arial,sans-serif"

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

/**
 * Names and titles people typed go in as Unicode isolates (FSI … PDI), so an
 * English name inside an Arabic sentence (or the reverse) keeps its own
 * direction instead of scrambling the word order.
 */
export const isolate = (value: string) => (value ? `\u2068${value}\u2069` : "")

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_match: string, name: string) => isolate(vars[name] ?? ""))

export type RenderedMail = { subject: string; text: string; html: string }

/** One language's part of an email. */
type Content = {
  subject: string
  paragraphs: string[]
  action?: { label: string; url: string }
  footer: string[]
}

/** The recipient's language first, then the other. */
const inOrder = (first: Locale): Locale[] => (first === "ar" ? ["ar", "en"] : LOCALES)

function header(origin: string): string {
  const logo = origin
    ? `<td style="padding-right:10px;vertical-align:middle;"><img src="${escapeHtml(origin)}/icons/icon-192.png" width="32" height="32" alt="" style="display:block;border:0;border-radius:8px;"></td>`
    : ""
  return (
    `<tr><td dir="ltr" style="padding:22px 28px 18px;border-bottom:1px solid ${LINE};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${logo}` +
    `<td style="vertical-align:middle;"><span style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:${INK};">Taskly</span></td>` +
    `</tr></table>` +
    `<p style="margin:6px 0 0;font-size:12px;color:${MUTED};">${escapeHtml(en.email.tagline)}` +
    ` &middot; <span dir="rtl" lang="ar">${escapeHtml(ar.email.tagline)}</span></p>` +
    `</td></tr>`
  )
}

const paragraph = (text: string, color = INK, size = 15, bottom = 14) =>
  `<p style="margin:0 0 ${bottom}px;font-size:${size}px;line-height:1.6;color:${color};">${escapeHtml(text)}</p>`

const cell = (locale: Locale, body: string, padding: string, divider: boolean) =>
  `<tr><td dir="${locale === "ar" ? "rtl" : "ltr"}" lang="${locale}" style="padding:${padding};text-align:${locale === "ar" ? "right" : "left"};${divider ? `border-bottom:1px solid ${LINE};` : ""}">${body}</td></tr>`

/** One language's message (no button: the email has a single one below both). */
function section(locale: Locale, content: Content, divider: boolean): string {
  return cell(
    locale,
    content.paragraphs.map((text) => paragraph(text)).join(""),
    `22px 28px ${divider ? 8 : 4}px`,
    divider,
  )
}

/** The one button, labelled in both languages (recipient's first). */
function button(action: { label: string; url: string }): string {
  return (
    `<tr><td align="center" style="padding:14px 28px 22px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${GOLD};">` +
    `<a href="${escapeHtml(action.url)}" dir="auto" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:${INK};text-decoration:none;">${escapeHtml(action.label)}</a>` +
    `</td></tr></table></td></tr>`
  )
}

/** Each language's small print, under the button. */
function notes(locale: Locale, lines: string[]): string {
  if (lines.length === 0) return ""
  return cell(locale, lines.map((text) => paragraph(text, MUTED, 12, 6)).join(""), "0 28px 10px", false)
}

function footer(origin: string): string {
  const site = origin ? origin.replace(/^https?:\/\//, "") : ""
  return (
    `<tr><td dir="ltr" style="padding:14px 28px;background:#faf8f4;border-top:1px solid ${LINE};border-radius:0 0 12px 12px;text-align:center;">` +
    `<p style="margin:0;font-size:11px;color:${MUTED};">Taskly` +
    (site
      ? ` &middot; <a href="${escapeHtml(origin)}" style="color:${MUTED};">${escapeHtml(site)}</a>`
      : "") +
    `</p></td></tr>`
  )
}

/** Both languages in one email, `first` on top, and a single button below them. */
function bilingual(first: Locale, origin: string, build: (locale: Locale) => Content): RenderedMail {
  const parts = inOrder(first).map((locale) => ({ locale, content: build(locale) }))
  // Every language links to the same place; one button carries both labels.
  const actions = parts.flatMap(({ content }) => (content.action ? [content.action] : []))
  const action = actions.length
    ? { url: actions[0].url, label: actions.map((a) => a.label).join(" · ") }
    : null
  const html = [
    `<!doctype html><html lang="${first}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`,
    `<body style="margin:0;padding:24px 12px;background:#f6f4f0;font-family:${FONT};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e7e2d8;border-radius:12px;">`,
    header(origin),
    ...parts.map(({ locale, content }, i) => section(locale, content, i < parts.length - 1)),
    action ? button(action) : `<tr><td style="padding:0 0 12px;"></td></tr>`,
    ...parts.map(({ locale, content }) => notes(locale, content.footer)),
    footer(origin),
    `</table></td></tr></table></body></html>`,
  ].join("")
  const text = [
    "Taskly",
    parts.map(({ content }) => content.paragraphs.join("\n\n")).join("\n\n———\n\n"),
    ...(action ? [`${action.label}:\n${action.url}`] : []),
    ...parts.flatMap(({ content }) => (content.footer.length ? [content.footer.join("\n")] : [])),
  ].join("\n\n")
  return { subject: parts.map(({ content }) => content.subject).join(" | "), text, html }
}

/** A notification by email: `text` is the bell sentence, rendered in each language. */
export function notificationMail(
  first: Locale,
  {
    text,
    url,
    settingsUrl,
    origin,
  }: { text: Record<Locale, string>; url: string | null; settingsUrl: string; origin: string },
): RenderedMail {
  return bilingual(first, origin, (locale) => {
    const dict = DICTIONARIES[locale].email
    const sentence = text[locale]
    return {
      subject: sentence.length > 90 ? `${sentence.slice(0, 87)}…` : sentence,
      paragraphs: [sentence],
      action: url ? { label: dict.openInTaskly, url } : undefined,
      footer: [`${dict.notificationFooter} ${settingsUrl}`],
    }
  })
}

/**
 * The invitation to a new account: a one-time link to set a password. From a
 * workspace administrator (`workspace` set) or an operator (no workspace yet).
 */
export function invitationMail(
  first: Locale,
  {
    name,
    actor,
    workspace,
    url,
    origin,
  }: { name: string; actor: string; workspace: string | null; url: string; origin: string },
): RenderedMail {
  const vars = { name, actor, workspace: workspace ?? "" }
  return bilingual(first, origin, (locale) => {
    const dict = DICTIONARIES[locale].email.invite
    return {
      subject: fill(workspace ? dict.subject : dict.subjectPlatform, vars),
      paragraphs: [fill(dict.greeting, vars), fill(workspace ? dict.body : dict.bodyPlatform, vars)],
      action: { label: dict.action, url },
      footer: [fill(dict.expiry, vars), dict.ignore],
    }
  })
}

/** Someone with an account was invited to a workspace; they accept or decline in the app. */
export function workspaceInviteMail(
  first: Locale,
  {
    name,
    actor,
    workspace,
    role,
    url,
    origin,
  }: { name: string; actor: string; workspace: string; role: Role; url: string; origin: string },
): RenderedMail {
  return bilingual(first, origin, (locale) => {
    const dict = DICTIONARIES[locale]
    const mail = dict.email.workspaceInvite
    const vars = { name, actor, workspace, role: dict.roles[role] }
    return {
      subject: fill(mail.subject, vars),
      paragraphs: [fill(mail.greeting, vars), fill(mail.body, vars)],
      action: { label: mail.action, url },
      footer: [mail.footer],
    }
  })
}

/** "Forgot password?": a one-time link to choose a new password. */
export function passwordResetMail(
  first: Locale,
  { name, email, url, origin }: { name: string; email: string; url: string; origin: string },
): RenderedMail {
  return bilingual(first, origin, (locale) => {
    const dict = DICTIONARIES[locale].email.reset
    const vars = { name, email }
    return {
      subject: dict.subject,
      paragraphs: [fill(dict.greeting, vars), fill(dict.body, vars)],
      action: { label: dict.action, url },
      footer: [dict.expiry, dict.ignore],
    }
  })
}

/** A short message with nothing else, in both languages (the console's test email). */
export function plainMail(
  first: Locale,
  {
    subject,
    text,
    origin,
  }: { subject: Record<Locale, string>; text: Record<Locale, string>; origin: string },
): RenderedMail {
  return bilingual(first, origin, (locale) => ({
    subject: subject[locale],
    paragraphs: [text[locale]],
    footer: [],
  }))
}

/** Confirm an address someone added to their account. */
export function verifyEmailMail(
  first: Locale,
  { name, email, url, origin }: { name: string; email: string; url: string; origin: string },
): RenderedMail {
  return bilingual(first, origin, (locale) => {
    const dict = DICTIONARIES[locale].email.verify
    const vars = { name, email }
    return {
      subject: dict.subject,
      paragraphs: [fill(dict.greeting, vars), fill(dict.body, vars)],
      action: { label: dict.action, url },
      footer: [dict.expiry, dict.ignore],
    }
  })
}
