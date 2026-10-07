/**
 * Notifications: in-app (the bell list) and Web Push, filtered by each
 * recipient's preferences. Events store structured data; the text is rendered
 * when read, in the reader's current language.
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
import { sendPushes } from "@/server/push"
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
  task_due_today: "task_reminders",
  task_due_tomorrow: "task_reminders",
  task_overdue: "task_reminders",
} as const satisfies Record<string, NotificationKind>

export type NotificationEvent = keyof typeof EVENT_KIND

type EventData = {
  actor: string
  workspace?: string
  ref?: string
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
  }: {
    recipients: string[]
    actorId: string
    event: NotificationEvent
    accountId: string | null
    data: EventData
    link: string | null
  },
): Promise<void> {
  const ids = [...new Set(recipients)].filter((id) => id && id !== actorId)
  if (ids.length === 0) return
  const kind = EVENT_KIND[event]

  const rows = await all<{ id: string; in_app: number | null; push: number | null }>(
    ctx.db,
    `SELECT u.id, p.in_app, p.push FROM users u
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

  for (const row of rows) {
    const inApp = row.in_app !== 0
    const push = row.push !== 0
    if (!inApp && !push) continue
    if (push) pushUsers.push(row.id)
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO notifications (id, user_id, account_id, type, data, link, in_app, push, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId("n"), row.id, accountId, event, payload, link, inApp ? 1 : 0, push ? 1 : 0, now),
      // Housekeeping: keep each person's list to the last couple of months.
      ctx.db
        .prepare("DELETE FROM notifications WHERE user_id = ? AND created_at < ?")
        .bind(row.id, cutoff),
    )
  }
  if (statements.length === 0) return
  await ctx.db.batch(statements)

  if (pushUsers.length > 0 && ctx.env.VAPID_PRIVATE_KEY) {
    ctx.waitUntil(deliverPush(ctx, pushUsers))
  }
}

async function deliverPush(ctx: Ctx, userIds: string[]): Promise<void> {
  const subs = await all<{ endpoint: string }>(
    ctx.db,
    "SELECT endpoint FROM push_subscriptions WHERE user_id IN (SELECT value FROM json_each(?))",
    JSON.stringify(userIds),
  )
  const gone = await sendPushes(
    subs.map((s) => s.endpoint),
    {
      publicKey: ctx.env.VAPID_PUBLIC_KEY,
      privateKey: ctx.env.VAPID_PRIVATE_KEY,
      subject: ctx.env.VAPID_SUBJECT,
    },
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
  const vars: Record<string, string> = {
    actor: data.actor ?? "",
    workspace: data.workspace ?? "",
    ref: data.ref ?? "",
    title: data.title ?? "",
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
  const rows = await all<{ type: string; in_app: number; push: number }>(
    ctx.db,
    "SELECT type, in_app, push FROM notification_prefs WHERE user_id = ?",
    me.id,
  )
  const prefs = {} as NotificationPrefs
  for (const kind of NOTIFICATION_KINDS) {
    const row = rows.find((r) => r.type === kind)
    prefs[kind] = { inApp: row ? row.in_app === 1 : true, push: row ? row.push === 1 : true }
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
  const column = oneOf<NotificationChannel>(channel, ["inApp", "push"]) === "inApp" ? "in_app" : "push"
  const value = bool(enabled) ? 1 : 0
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

/** The public VAPID key the browser needs to subscribe this device. */
export async function getPushPublicKey(ctx: Ctx): Promise<string | null> {
  await requireUser(ctx)
  return ctx.env.VAPID_PRIVATE_KEY ? ctx.env.VAPID_PUBLIC_KEY : null
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
