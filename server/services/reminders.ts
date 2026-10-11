/**
 * Due date reminders, run hourly by the Cron Trigger. Each person gets them
 * once a day at 08:00 in their own time zone: tasks due today, due tomorrow,
 * and (once) tasks that became overdue yesterday. Sent reminders are logged in
 * `task_reminders`, so a repeated or retried run never sends one twice.
 */
import type { Ctx } from "@/server/context"
import { all, nowIso } from "@/server/db"
import { notify, type NotificationEvent } from "@/server/services/notifications"

const SEND_AT_HOUR = 8

type Candidate = {
  task_id: string
  account_id: string
  title: string
  due_date: string
  due_time: string
  user_id: string
  workspace: string
}

/** Local calendar date (YYYY-MM-DD) and hour for `at` in `zone`. */
function localParts(at: Date, zone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) }
}

function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function zoneOrUtc(zone: string | null): string {
  if (!zone) return "UTC"
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return zone
  } catch {
    return "UTC"
  }
}

/** Send whatever reminders are due at `at`. Returns how many were sent. */
export async function runDueReminders(ctx: Ctx, at: Date): Promise<number> {
  // Time zones of people who could receive a reminder.
  const zones = await all<{ zone: string | null }>(
    ctx.db,
    "SELECT DISTINCT timezone AS zone FROM users WHERE active = 1 AND deleted_at IS NULL",
  )
  let sent = 0
  for (const { zone } of zones) {
    const tz = zoneOrUtc(zone)
    const { date: today, hour } = localParts(at, tz)
    if (hour !== SEND_AT_HOUR) continue
    const tomorrow = shiftDate(today, 1)
    const yesterday = shiftDate(today, -1)

    // Open tasks assigned to people in this zone, due yesterday..tomorrow,
    // in active workspaces they still belong to. (Already-sent reminders are
    // filtered by the INSERT OR IGNORE below, per kind.)
    const rows = await all<Candidate>(
      ctx.db,
      `SELECT t.id AS task_id, t.account_id, t.title, t.due_date, t.due_time,
              ta.user_id, a.name AS workspace
       FROM tasks t
       JOIN task_assignees ta ON ta.task_id = t.id
       JOIN users u ON u.id = ta.user_id
       JOIN accounts a ON a.id = t.account_id AND a.active = 1
       JOIN memberships ms ON ms.account_id = t.account_id AND ms.user_id = ta.user_id
       WHERE ${zone === null ? "u.timezone IS NULL" : "u.timezone = ?"}
         AND u.active = 1 AND u.deleted_at IS NULL
         AND t.status NOT IN ('completed', 'cancelled')
         AND t.due_date IN (?, ?, ?)`,
      ...(zone === null ? [] : [zone]),
      yesterday,
      today,
      tomorrow,
    )
    if (rows.length === 0) continue

    // Group by task + kind so each task is one notify() call for all its people.
    const groups = new Map<string, { event: NotificationEvent; row: Candidate; users: string[] }>()
    for (const row of rows) {
      const event: NotificationEvent =
        row.due_date === today ? "task_due_today" : row.due_date === tomorrow ? "task_due_tomorrow" : "task_overdue"
      const key = `${row.task_id}:${event}`
      const group = groups.get(key) ?? { event, row, users: [] }
      group.users.push(row.user_id)
      groups.set(key, group)
    }

    const now = nowIso()
    for (const { event, row, users } of groups.values()) {
      // Log first: if two runs overlap, the primary key lets only one through.
      const results = await ctx.db.batch(
        users.map((userId) =>
          ctx.db
            .prepare(
              `INSERT OR IGNORE INTO task_reminders (task_id, user_id, kind, due_date, sent_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(row.task_id, userId, event, row.due_date, now),
        ),
      )
      const recipients = users.filter((_, i) => (results[i]?.meta.changes ?? 0) > 0)
      if (recipients.length === 0) continue
      await notify(ctx, {
        recipients,
        actorId: "",
        event,
        accountId: row.account_id,
        data: {
          actor: "",
          workspace: row.workspace,
          title: row.title,
          date: row.due_date,
          time: event === "task_overdue" ? undefined : row.due_time || undefined,
        },
        link: `/w/${row.account_id}/tasks?task=${row.task_id}`,
      })
      sent += recipients.length
    }
  }
  return sent
}
