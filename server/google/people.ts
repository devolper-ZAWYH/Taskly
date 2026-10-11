/**
 * Shared lookups for sync: who gets Google copies, the workspace time zone,
 * and the footer Taskly writes under each copy (in the reader's language).
 */
import type { Locale, Meeting, Task } from "@/lib/types"
import ar from "@/messages/ar"
import en from "@/messages/en"
import type { Ctx } from "@/server/context"
import { all, first } from "@/server/db"
import { appUrl } from "@/server/settings"
import { notify, type NotificationEvent } from "@/server/services/notifications"

const DICTIONARIES = { en, ar }

/**
 * Of `userIds`, the people who should have Google copies of this workspace's
 * items: connected (and not revoked), active, and still members of an active workspace.
 */
export async function connectedMembers(
  ctx: Ctx,
  accountId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return []
  const rows = await all<{ user_id: string }>(
    ctx.db,
    `SELECT gc.user_id FROM google_connections gc
     JOIN users u ON u.id = gc.user_id AND u.active = 1 AND u.deleted_at IS NULL
     JOIN memberships ms ON ms.user_id = gc.user_id AND ms.account_id = ?
     JOIN accounts a ON a.id = ms.account_id AND a.active = 1
     WHERE gc.state = 'active' AND gc.user_id IN (SELECT value FROM json_each(?))`,
    accountId,
    JSON.stringify([...new Set(userIds)]),
  )
  return rows.map((row) => row.user_id)
}

function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return zone
  } catch {
    return null
  }
}

/** The zone a workspace's meeting times mean: the workspace's, else `userId`'s, else UTC. */
export async function workspaceZone(ctx: Ctx, accountId: string, userId: string): Promise<string> {
  const row = await first<{ account_zone: string | null; user_zone: string | null }>(
    ctx.db,
    `SELECT (SELECT timezone FROM accounts WHERE id = ?) AS account_zone,
            (SELECT timezone FROM users WHERE id = ?) AS user_zone`,
    accountId,
    userId,
  )
  return validZone(row?.account_zone) ?? validZone(row?.user_zone) ?? "UTC"
}

async function localeOf(ctx: Ctx, userId: string): Promise<Locale> {
  const row = await first<{ locale: string }>(ctx.db, "SELECT locale FROM users WHERE id = ?", userId)
  return row?.locale === "ar" ? "ar" : "en"
}

async function namesOf(ctx: Ctx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await all<{ id: string; name: string }>(
    ctx.db,
    "SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ids),
  )
  const byId = new Map(rows.map((row) => [row.id, row.name]))
  return ids.map((id) => byId.get(id)).filter((name): name is string => Boolean(name))
}

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_match: string, name: string) => vars[name] ?? "")

/** Footer lines under a task's Google copy, for `userId` to read. */
export async function taskFooter(ctx: Ctx, task: Task, userId: string): Promise<string[]> {
  const dict = DICTIONARIES[await localeOf(ctx, userId)]
  const f = dict.google.footer
  const lines = [f.hint]
  if (task.dueTime) lines.push(fill(f.due, { time: task.dueTime }))
  if (task.priority !== "none") {
    lines.push(fill(f.priority, { priority: dict.tasks.priority[task.priority] }))
  }
  const assignees = await namesOf(ctx, task.assigneeIds)
  if (assignees.length > 0) lines.push(fill(f.assignees, { names: assignees.join(", ") }))
  lines.push(
    fill(f.open, { url: await appUrl(ctx, `/w/${task.accountId}/tasks?task=${task.id}`) }),
  )
  return lines
}

/** Footer lines under a meeting's Google copy, for `userId` to read. */
export async function meetingFooter(ctx: Ctx, meeting: Meeting, userId: string): Promise<string[]> {
  const f = DICTIONARIES[await localeOf(ctx, userId)].google.footer
  const [organizer] = await namesOf(ctx, [meeting.organizerId])
  const attendees = await namesOf(ctx, meeting.attendeeIds)
  const lines = [f.hint]
  if (organizer) lines.push(fill(f.organizer, { name: organizer }))
  if (attendees.length > 0) lines.push(fill(f.attendees, { names: attendees.join(", ") }))
  const path = `/w/${meeting.accountId}/calendar?view=week&date=${meeting.date}&meeting=${meeting.id}`
  lines.push(fill(f.open, { url: await appUrl(ctx, path) }))
  return lines
}

export async function workspaceName(ctx: Ctx, accountId: string): Promise<string> {
  const row = await first<{ name: string }>(ctx.db, "SELECT name FROM accounts WHERE id = ?", accountId)
  return row?.name ?? ""
}

/** A sync notice to one person (reverted change, moved or restored item). */
export async function noticeTo(
  ctx: Ctx,
  userId: string,
  event: NotificationEvent,
  details: { accountId: string; title: string; link?: string | null },
): Promise<void> {
  await notify(ctx, {
    recipients: [userId],
    actorId: "",
    event,
    accountId: details.accountId,
    data: {
      actor: "",
      workspace: await workspaceName(ctx, details.accountId),
      title: details.title,
    },
    link: details.link ?? null,
  })
}
