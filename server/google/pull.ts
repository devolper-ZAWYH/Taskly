/**
 * Changes made in Google → Taskly. Workspace task lists are polled with
 * `updatedMin` (Google Tasks has no push); workspace calendars are read
 * incrementally with a sync token, triggered by push notifications or the cron.
 */
import type { Ctx } from "@/server/context"
import { first, nowIso, run } from "@/server/db"
import { calendarApi, tasksApi } from "@/server/google/apis"
import { GoogleError, googleFor } from "@/server/google/client"
import { containerGone } from "@/server/google/containers"
import type { GoogleEvent, GoogleTask } from "@/server/google/mapping"
import { queueGoogleSync } from "@/server/google/queue"
import { taskSyncs } from "@/server/google/policy"
import { linkByGoogleId, touchSynced, type ContainerRow } from "@/server/google/store"
import { importEvent, syncMeetingCopy } from "@/server/google/sync-meetings"
import { importTask, syncTaskCopy } from "@/server/google/sync-tasks"
import { findMeeting } from "@/server/services/meetings"
import { findTask } from "@/server/services/tasks"

/** Re-read a little before the last poll: clocks differ, and re-reading is a no-op. */
const OVERLAP_MS = 2 * 60_000

/** `ref` is `tasklist:<googleId>` or `calendar:<googleId>` (one of their workspace containers). */
export async function pullContainer(ctx: Ctx, userId: string, ref: string): Promise<void> {
  const split = ref.indexOf(":")
  const kind = ref.slice(0, split)
  const googleId = ref.slice(split + 1)
  const container = await first<ContainerRow>(
    ctx.db,
    `SELECT * FROM google_containers
     WHERE user_id = ? AND kind = ? AND google_id = ? AND account_id IS NOT NULL`,
    userId,
    kind,
    googleId,
  )
  if (!container) return
  if (container.kind === "tasklist") await pullTasklist(ctx, container)
  else await pullCalendar(ctx, container)
  await touchSynced(ctx.db, userId)
}

async function pullTasklist(ctx: Ctx, container: ContainerRow): Promise<void> {
  const g = await googleFor(ctx, container.user_id)
  const startedAt = new Date(Date.now() - OVERLAP_MS).toISOString()
  let items: GoogleTask[]
  try {
    items = await tasksApi.list(g, container.google_id, {
      updatedMin: container.polled_at ?? undefined,
      showCompleted: true,
      showHidden: true,
      showDeleted: true,
    })
  } catch (error) {
    if (error instanceof GoogleError && error.status === 404) return containerGone(ctx, container)
    throw error
  }
  for (const item of items) await pullTask(ctx, container, item)
  await run(
    ctx.db,
    "UPDATE google_containers SET polled_at = ? WHERE user_id = ? AND kind = ? AND google_id = ?",
    startedAt,
    container.user_id,
    container.kind,
    container.google_id,
  )
}

async function pullTask(ctx: Ctx, container: ContainerRow, item: GoogleTask): Promise<void> {
  const userId = container.user_id
  const link = await linkByGoogleId(ctx.db, userId, item.id)
  if (!link) {
    if (!item.deleted) await importTask(ctx, userId, container, item)
    return
  }
  const task = await findTask(ctx, link.account_id, link.entity_id)
  if (!task || !taskSyncs(task) || !task.assigneeIds.includes(userId)) {
    // Taskly no longer wants this copy; the task's sync removes it.
    await queueGoogleSync(ctx, "task", link.account_id, link.entity_id, { drain: false })
    return
  }
  await syncTaskCopy(ctx, userId, task, link, item.deleted ? null : item)
}

async function pullCalendar(ctx: Ctx, container: ContainerRow): Promise<void> {
  const g = await googleFor(ctx, container.user_id)
  let result: { items: GoogleEvent[]; nextSyncToken?: string }
  try {
    result = await calendarApi.events(
      g,
      container.google_id,
      container.sync_token ? { syncToken: container.sync_token } : { showDeleted: true },
    )
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    if (error.status === 404) return containerGone(ctx, container)
    if (error.status !== 410) throw error
    // The sync token expired: read everything again (each event reconciles as a no-op if unchanged).
    result = await calendarApi.events(g, container.google_id, { showDeleted: true })
  }
  for (const event of result.items) await pullEvent(ctx, container, event)
  await run(
    ctx.db,
    `UPDATE google_containers SET sync_token = COALESCE(?, sync_token), polled_at = ?
     WHERE user_id = ? AND kind = ? AND google_id = ?`,
    result.nextSyncToken ?? null,
    nowIso(),
    container.user_id,
    container.kind,
    container.google_id,
  )
}

async function pullEvent(ctx: Ctx, container: ContainerRow, event: GoogleEvent): Promise<void> {
  const userId = container.user_id
  const link = await linkByGoogleId(ctx.db, userId, event.id)
  if (!link) {
    if (event.status !== "cancelled") await importEvent(ctx, userId, container, event)
    return
  }
  const meeting = await findMeeting(ctx, link.account_id, link.entity_id)
  if (!meeting || (meeting.organizerId !== userId && !meeting.attendeeIds.includes(userId))) {
    await queueGoogleSync(ctx, "meeting", link.account_id, link.entity_id, { drain: false })
    return
  }
  await syncMeetingCopy(ctx, userId, meeting, link, event.status === "cancelled" ? null : event)
}
