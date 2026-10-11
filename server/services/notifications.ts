/**
 * Notifications: in-app (the bell list), Web Push and email, filtered by each
 * recipient's preferences (email is off unless they turn it on). Events store
 * structured data; the text is rendered when read, in the reader's current
 * language.
 */
import { AppError } from "@/lib/api/core"
import {
  NOTIFICATION_KINDS,
  type AppNotification,
  type Locale,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPrefs,
  type TaskStatus,
} from "@/lib/types"
import ar from "@/messages/ar"
import en from "@/messages/en"
import { requireUser, type Ctx } from "@/server/context"
import { newId } from "@/server/crypto"
import { all, first, nowIso, run } from "@/server/db"
import { mailConfigured, sendMail } from "@/server/mail/send"
import { isolate, notificationMail } from "@/server/mail/templates"
import { sendPushes } from "@/server/push"
import { appOrigin, appUrl, pushKeys, type PushKeys } from "@/server/settings"
import { bool, isObject, oneOf, str } from "@/server/validate"

/** Every event, and the preference group that controls it. */
const EVENT_KIND = {
  task_assigned: "task_assigned",
  task_status: "task_updated",
  task_due: "task_updated",
  meeting_invited: "meeting_invited",
  meeting_updated: "meeting_changed",
  meeting_cancelled: "meeting_changed",
  workspace_added: "workspace_added",
  workspace_invited: "workspace_added",
  workspace_invite_accepted: "workspace_added",
  workspace_invite_declined: "workspace_added",
  task_due_today: "task_reminders",
  task_due_tomorrow: "task_reminders",
  task_overdue: "task_reminders",
  google_change_reverted: "google_sync",
  google_event_moved: "google_sync",
  google_item_restored: "google_sync",
  google_reconnect: "google_sync",
  google_sync_failed: "google_sync",
} as const satisfies Record<string, NotificationKind>

export type NotificationEvent = keyof typeof EVENT_KIND

type EventData = {
  actor: string
  workspace?: string
  title?: string
  status?: TaskStatus
  date?: string
  time?: string
}

const KEEP_DAYS = 60

// ---- Sending ---------------------------------------------------------------

/**
 * Notify people about something `actorId` did. The actor never notifies
 * themselves; inactive people are skipped; each person's preferences decide
 * the channels. Push delivery runs after the response is sent.
 */
export async function notify(
  ctx: Ctx,
  {
    recipients,
    actorId,
    event,
    accountId,
    data,
    link,
    email: emailChannel = true,
  }: {
    recipients: string[]
    actorId: string
    event: NotificationEvent
    accountId: string | null
    data: EventData
    link: string | null
    /** False when the caller sends its own email (an invitation that needs an answer). */
    email?: boolean
  },
): Promise<void> {
  const ids = [...new Set(recipients)].filter((id) => id && id !== actorId)
  if (ids.length === 0) return
  const kind = EVENT_KIND[event]

  const rows = await all<{
    id: string
    in_app: number | null
    push: number | null
    email: number | null
  }>(
    ctx.db,
    `SELECT u.id, p.in_app, p.push, p.email FROM users u
     LEFT JOIN notification_prefs p ON p.user_id = u.id AND p.type = ?
     WHERE u.active = 1 AND u.deleted_at IS NULL AND u.id IN (SELECT value FROM json_each(?))`,
    kind,
    JSON.stringify(ids),
  )
  const now = nowIso()
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()
  const payload = JSON.stringify({ event, ...data })
  const statements: D1PreparedStatement[] = []
  const pushUsers: string[] = []
  const emailUsers: string[] = []
  const canEmail = await mailConfigured(ctx)

  for (const row of rows) {
    const inApp = row.in_app !== 0
    const push = row.push !== 0
    // Email only when they switched it on (no row: off).
    const email = row.email === 1 && canEmail && emailChannel
    if (!inApp && !push && !email) continue
    if (push) pushUsers.push(row.id)
    if (email) emailUsers.push(row.id)
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO notifications (id, user_id, account_id, type, data, link, in_app, push, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId("n"),
          row.id,
          accountId,
          event,
          payload,
          link,
          inApp ? 1 : 0,
          push ? 1 : 0,
          email ? 1 : 0,
          now,
        ),
      // Housekeeping: keep each person's list to the last couple of months.
      ctx.db
        .prepare("DELETE FROM notifications WHERE user_id = ? AND created_at < ?")
        .bind(row.id, cutoff),
    )
  }
  if (statements.length === 0) return
  await ctx.db.batch(statements)

  const keys = pushUsers.length > 0 ? await pushKeys(ctx) : null
  if (keys) ctx.waitUntil(deliverPush(ctx, pushUsers, keys))
  if (emailUsers.length > 0) {
    ctx.waitUntil(deliverEmail(ctx, emailUsers, accountId, payload, link).catch(logEmailError))
  }
}

/** One email per person, in their language first, with a link back to the item. */
async function deliverEmail(
  ctx: Ctx,
  userIds: string[],
  accountId: string | null,
  payload: string,
  link: string | null,
): Promise<void> {
  // To the address this workspace knows them by, else their primary.
  const users = await all<{ email: string; name: string; locale: string }>(
    ctx.db,
    `SELECT u.name, u.locale, COALESCE(
       (SELECT ms.email FROM memberships ms WHERE ms.user_id = u.id AND ms.account_id = ?),
       u.email) AS email
     FROM users u WHERE u.id IN (SELECT value FROM json_each(?))`,
    accountId,
    JSON.stringify(userIds),
  )
  const url = link ? await appUrl(ctx, link) : null
  const settingsUrl = await appUrl(ctx, "/settings")
  const origin = await appOrigin(ctx)
  // Every email carries both languages; the recipient's comes first.
  const text = { en: render("en", payload), ar: render("ar", payload) }
  await sendMail(
    ctx,
    users.map((user) => {
      const locale: Locale = user.locale === "ar" ? "ar" : "en"
      return {
        to: { name: user.name, email: user.email },
        mail: notificationMail(locale, { text, url, settingsUrl, origin }),
        // Tells mail servers and autoresponders this was sent by the app.
        headers: { "Auto-Submitted": "auto-generated" },
      }
    }),
  )
}

function logEmailError(error: unknown): void {
  console.error("notification email failed", error)
}

async function deliverPush(ctx: Ctx, userIds: string[], keys: PushKeys): Promise<void> {
  const subs = await all<{ endpoint: string }>(
    ctx.db,
    "SELECT endpoint FROM push_subscriptions WHERE user_id IN (SELECT value FROM json_each(?))",
    JSON.stringify(userIds),
  )
  const gone = await sendPushes(
    subs.map((s) => s.endpoint),
    keys,
  )
  if (gone.length > 0) {
    await run(
      ctx.db,
      "DELETE FROM push_subscriptions WHERE endpoint IN (SELECT value FROM json_each(?))",
      JSON.stringify(gone),
    )
  }
}

// ---- Rendering -------------------------------------------------------------

const DICTIONARIES = { en, ar }

function intlLocale(locale: Locale): string {
  return locale === "ar" ? "ar-QA-u-nu-latn" : "en-GB"
}

/** Server-side twin of the UI's `t()` for the notification templates. */
function render(locale: Locale, raw: string): string {
  const dict = DICTIONARIES[locale]
  let data: EventData & { event?: NotificationEvent }
  try {
    data = JSON.parse(raw) as EventData & { event?: NotificationEvent }
  } catch {
    return ""
  }
  const template = data.event ? dict.notifications.text[data.event] : undefined
  if (!template) return ""
  const date = data.date
    ? new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short" }).format(
        new Date(`${data.date}T00:00:00`),
      )
    : ""
  // Typed names and titles keep their own direction inside the other language's sentence.
  const vars: Record<string, string> = {
    actor: isolate(data.actor ?? ""),
    workspace: isolate(data.workspace ?? ""),
    title: isolate(data.title ?? ""),
    status: data.status ? dict.tasks.status[data.status] : "",
    date: data.time ? `${date}, ${data.time}` : date,
    // Reminders: " at 14:30" / " الساعة 14:30" when the due date has a time.
    time: data.time ? (locale === "ar" ? ` الساعة ${data.time}` : ` at ${data.time}`) : "",
  }
  return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => vars[name] ?? "")
}

type NotificationRow = {
  id: string
  data: string
  link: string | null
  read_at: string | null
  created_at: string
  workspace: string | null
}

const toNotification = (locale: Locale) => (row: NotificationRow): AppNotification => ({
  id: row.id,
  text: render(locale, row.data),
  link: row.link,
  workspace: row.workspace,
  read: row.read_at !== null,
  createdAt: row.created_at,
})

// ---- Reading ---------------------------------------------------------------

/** Your latest in-app notifications (newest first) and the unread count. */
export async function listNotifications(
  ctx: Ctx,
): Promise<{ items: AppNotification[]; unread: number }> {
  const me = await requireUser(ctx)
  const [rows, count] = await Promise.all([
    all<NotificationRow>(
      ctx.db,
      `SELECT n.id, n.data, n.link, n.read_at, n.created_at, a.name AS workspace
       FROM notifications n LEFT JOIN accounts a ON a.id = n.account_id
       WHERE n.user_id = ? AND n.in_app = 1
       ORDER BY n.created_at DESC LIMIT 50`,
      me.id,
    ),
    first<{ unread: number }>(
      ctx.db,
      "SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND in_app = 1 AND read_at IS NULL",
      me.id,
    ),
  ])
  return { items: rows.map(toNotification(me.locale)), unread: count?.unread ?? 0 }
}

/** Just the unread count (cheap; polled by the sidebar badge). */
export async function unreadNotificationCount(ctx: Ctx): Promise<number> {
  const me = await requireUser(ctx)
  const row = await first<{ unread: number }>(
    ctx.db,
    "SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND in_app = 1 AND read_at IS NULL",
    me.id,
  )
  return row?.unread ?? 0
}

/** Mark some (by id) or all of your notifications as read. */
export async function markNotificationsRead(ctx: Ctx, ids: unknown): Promise<void> {
  const me = await requireUser(ctx)
  if (ids === "all") {
    await run(
      ctx.db,
      "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
      nowIso(),
      me.id,
    )
    return
  }
  if (!Array.isArray(ids) || ids.length > 100) throw new AppError("badRequest")
  await run(
    ctx.db,
    `UPDATE notifications SET read_at = ?
     WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    nowIso(),
    me.id,
    JSON.stringify(ids.map((id) => str(id, 100))),
  )
}

/**
 * What a just-woken service worker should show: your newest push
 * notification from the last few minutes, or null.
 */
export async function latestPushNotification(ctx: Ctx): Promise<AppNotification | null> {
  const me = await requireUser(ctx)
  const since = new Date(Date.now() - 10 * 60_000).toISOString()
  const row = await first<NotificationRow>(
    ctx.db,
    `SELECT n.id, n.data, n.link, n.read_at, n.created_at, a.name AS workspace
     FROM notifications n LEFT JOIN accounts a ON a.id = n.account_id
     WHERE n.user_id = ? AND n.push = 1 AND n.created_at >= ?
     ORDER BY n.created_at DESC LIMIT 1`,
    me.id,
    since,
  )
  return row ? toNotification(me.locale)(row) : null
}

// ---- Preferences & devices -------------------------------------------------

export async function getNotificationPrefs(ctx: Ctx): Promise<NotificationPrefs> {
  const me = await requireUser(ctx)
  const rows = await all<{ type: string; in_app: number; push: number; email: number }>(
    ctx.db,
    "SELECT type, in_app, push, email FROM notification_prefs WHERE user_id = ?",
    me.id,
  )
  const prefs = {} as NotificationPrefs
  for (const kind of NOTIFICATION_KINDS) {
    const row = rows.find((r) => r.type === kind)
    prefs[kind] = {
      inApp: row ? row.in_app === 1 : true,
      push: row ? row.push === 1 : true,
      email: row ? row.email === 1 : false,
    }
  }
  return prefs
}

export async function setNotificationPref(
  ctx: Ctx,
  kind: unknown,
  channel: unknown,
  enabled: unknown,
): Promise<NotificationPrefs> {
  const me = await requireUser(ctx)
  const type = oneOf(kind, NOTIFICATION_KINDS)
  const column = { inApp: "in_app", push: "push", email: "email" }[
    oneOf<NotificationChannel>(channel, ["inApp", "push", "email"])
  ]
  const value = bool(enabled) ? 1 : 0
  if (column === "email" && value === 1 && !(await mailConfigured(ctx))) {
    throw new AppError("mailNotConfigured")
  }
  await run(
    ctx.db,
    `INSERT INTO notification_prefs (user_id, type, ${column}) VALUES (?, ?, ?)
     ON CONFLICT (user_id, type) DO UPDATE SET ${column} = excluded.${column}`,
    me.id,
    type,
    value,
  )
  return getNotificationPrefs(ctx)
}

/** Whether this server can send email (the Settings "Email" column). */
export async function getEmailAvailable(ctx: Ctx): Promise<boolean> {
  await requireUser(ctx)
  return mailConfigured(ctx)
}

/** The public VAPID key the browser needs to subscribe this device. */
export async function getPushPublicKey(ctx: Ctx): Promise<string | null> {
  await requireUser(ctx)
  return (await pushKeys(ctx))?.publicKey ?? null
}

/** Remember this device's push endpoint for the signed-in person. */
export async function savePushSubscription(ctx: Ctx, input: unknown): Promise<void> {
  const me = await requireUser(ctx)
  if (!isObject(input)) throw new AppError("badRequest")
  const endpoint = str(input.endpoint, 1000)
  if (!/^https:\/\//.test(endpoint)) throw new AppError("badRequest")
  await run(
    ctx.db,
    `INSERT INTO push_subscriptions (endpoint, user_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id`,
    endpoint,
    me.id,
    nowIso(),
  )
}

export async function removePushSubscription(ctx: Ctx, endpoint: unknown): Promise<void> {
  const me = await requireUser(ctx)
  await run(
    ctx.db,
    "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
    str(endpoint, 1000),
    me.id,
  )
}
