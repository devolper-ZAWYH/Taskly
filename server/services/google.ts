/**
 * Google sync, as the signed-in person sees it: their connection, which of
 * their own calendars and task lists show in Taskly, and their personal Google
 * items (read and written live against Google).
 */
import { AppError } from "@/lib/api/core"
import type {
  GoogleContainer,
  GoogleContainerKind,
  GoogleEventImport,
  GoogleStatus,
  GoogleSyncHealth,
  Meeting,
  PersonalEvent,
  PersonalEventInput,
  PersonalTask,
  PersonalTaskInput,
} from "@/lib/types"
import { requireOperator, requireUser, requireWorkspaceAdmin, type Ctx } from "@/server/context"
import { all, nowIso, run } from "@/server/db"
import { calendarApi } from "@/server/google/apis"
import { googleFor } from "@/server/google/client"
import { googleConfigured, googleTasksEnabled, tasksSyncFor } from "@/server/google/config"
import { purgeUser, refreshPersonalContainers } from "@/server/google/containers"
import { failedJobCount, retryFailedJobs, syncHealth } from "@/server/google/health"
import { eventGuestEmails, eventSourceKey, importableFields } from "@/server/google/mapping"
import { workspaceZone } from "@/server/google/people"
import * as personal from "@/server/google/personal"
import { viaGoogle } from "@/server/google/personal"
import { drainJobs, enqueue, queueGoogleSync } from "@/server/google/queue"
import { containersOf, getConnection, toContainer, type ContainerRow } from "@/server/google/store"
import { createMeetingAs } from "@/server/services/meetings"
import { bool, date, isObject, oneOf, str, time, timeZone } from "@/server/validate"

const KINDS = ["tasklist", "calendar"] as const satisfies readonly GoogleContainerKind[]

export async function getGoogleStatus(ctx: Ctx): Promise<GoogleStatus> {
  const me = await requireUser(ctx)
  const configured = await googleConfigured(ctx)
  const row = configured ? await getConnection(ctx.db, me.id) : null
  return {
    configured,
    tasksEnabled: configured && (await googleTasksEnabled(ctx)),
    tasks: Boolean(row) && (await tasksSyncFor(ctx, me.id)),
    connected: Boolean(row),
    email: row?.google_email ?? null,
    state: row?.state ?? null,
    lastError: row?.last_error ?? null,
    lastSyncAt: row?.last_sync_at ?? null,
    failedJobs: row ? await failedJobCount(ctx, me.id) : 0,
  }
}

/** The signed-in person, who must have connected Google (and not lost access). */
async function requireConnected(ctx: Ctx): Promise<string> {
  const me = await requireUser(ctx)
  if (!(await googleConfigured(ctx))) throw new AppError("googleNotConfigured")
  const row = await getConnection(ctx.db, me.id)
  if (!row) throw new AppError("googleNotConnected")
  if (row.state === "revoked") throw new AppError("googleReconnect")
  return me.id
}

/** Connected, with tasks sync on and Google Tasks allowed. */
async function requireTasks(ctx: Ctx): Promise<string> {
  const userId = await requireConnected(ctx)
  if (!(await tasksSyncFor(ctx, userId))) throw new AppError("googleTasksOff")
  return userId
}

/**
 * Pull changes from their workspace lists and calendars now (the app calls
 * this when it opens, and from "Sync now"), then run their pending work.
 * `retryFailed` ("Sync now"): also retry their work that had stopped retrying.
 */
export async function syncGoogleNow(ctx: Ctx, retryFailed?: unknown): Promise<GoogleStatus> {
  const me = await requireUser(ctx)
  const row = (await googleConfigured(ctx)) ? await getConnection(ctx.db, me.id) : null
  if (row?.state === "active") {
    await run(ctx.db, "UPDATE google_connections SET last_seen_at = ? WHERE user_id = ?", nowIso(), me.id)
    if (retryFailed !== undefined && bool(retryFailed)) await retryFailedJobs(ctx, me.id)
    const containers = await all<ContainerRow>(
      ctx.db,
      "SELECT * FROM google_containers WHERE user_id = ? AND account_id IS NOT NULL",
      me.id,
    )
    await enqueue(
      ctx,
      containers.map((c) => ({ kind: "pull" as const, userId: me.id, entityId: `${c.kind}:${c.google_id}` })),
      { drain: false },
    )
    await drainJobs(ctx, { userId: me.id, limit: 20, budgetMs: 15_000 })
  }
  return getGoogleStatus(ctx)
}

/**
 * Remove the "Taskly · …" lists and calendars from their Google account,
 * revoke Taskly's access and forget the connection. Their own items stay.
 */
export async function disconnectGoogle(ctx: Ctx): Promise<void> {
  const me = await requireUser(ctx)
  await purgeUser(ctx, me.id)
}

/** `refresh`: ask Google for their current lists and calendars first. */
export async function listGoogleContainers(ctx: Ctx, refresh: unknown): Promise<GoogleContainer[]> {
  const userId = await requireConnected(ctx)
  if (bool(refresh)) {
    await viaGoogle(async () => refreshPersonalContainers(ctx, await googleFor(ctx, userId), userId))
  }
  return (await containersOf(ctx.db, userId)).map(toContainer)
}

/** Show or hide one of their own lists/calendars in Taskly. */
export async function setGoogleContainerSelected(
  ctx: Ctx,
  kind: unknown,
  id: unknown,
  selected: unknown,
): Promise<GoogleContainer[]> {
  const userId = await requireConnected(ctx)
  await run(
    ctx.db,
    `UPDATE google_containers SET selected = ?
     WHERE user_id = ? AND kind = ? AND google_id = ? AND account_id IS NULL`,
    bool(selected) ? 1 : 0,
    userId,
    oneOf(kind, KINDS),
    str(id, 1024),
  )
  return (await containersOf(ctx.db, userId)).map(toContainer)
}

// ---- Personal tasks ------------------------------------------------------------

// Google Tasks' own limits.
const MAX_TASK_TITLE = 1024
const MAX_TASK_NOTES = 8192

function personalTaskPatch(value: unknown): Partial<PersonalTaskInput> {
  if (!isObject(value)) throw new AppError("badRequest")
  const patch: Partial<PersonalTaskInput> = {}
  if (value.title !== undefined) {
    patch.title = str(value.title, MAX_TASK_TITLE).trim()
    if (!patch.title) throw new AppError("titleRequired")
  }
  if (value.notes !== undefined) patch.notes = str(value.notes, MAX_TASK_NOTES)
  if (value.dueDate !== undefined) patch.dueDate = date(value.dueDate)
  if (value.completed !== undefined) patch.completed = bool(value.completed)
  return patch
}

function personalTaskInput(value: unknown): PersonalTaskInput {
  const patch = personalTaskPatch(value)
  if (patch.title === undefined) throw new AppError("titleRequired")
  return { title: patch.title, notes: patch.notes ?? "", dueDate: patch.dueDate ?? "", completed: patch.completed ?? false }
}

const listId = (value: unknown) => str(value, 1024)
const optionalId = (value: unknown) => (value === null ? null : str(value, 1024))

export async function listPersonalTasks(ctx: Ctx, params: unknown): Promise<PersonalTask[]> {
  const userId = await requireConnected(ctx)
  if (!isObject(params)) throw new AppError("badRequest")
  if (!(await tasksSyncFor(ctx, userId))) return []
  const showCompleted = bool(params.showCompleted)
  return viaGoogle(() => personal.listTasks(ctx, userId, showCompleted))
}

export async function createPersonalTask(
  ctx: Ctx,
  tasklistId: unknown,
  input: unknown,
): Promise<PersonalTask> {
  const userId = await requireTasks(ctx)
  const value = personalTaskInput(input)
  return viaGoogle(() => personal.createTask(ctx, userId, optionalId(tasklistId), value))
}

export async function updatePersonalTask(
  ctx: Ctx,
  tasklistId: unknown,
  id: unknown,
  patch: unknown,
): Promise<PersonalTask> {
  const userId = await requireTasks(ctx)
  const value = personalTaskPatch(patch)
  return viaGoogle(() => personal.updateTask(ctx, userId, listId(tasklistId), str(id, 1024), value))
}

export async function deletePersonalTask(ctx: Ctx, tasklistId: unknown, id: unknown): Promise<void> {
  const userId = await requireTasks(ctx)
  return viaGoogle(() => personal.deleteTask(ctx, userId, listId(tasklistId), str(id, 1024)))
}

// ---- Personal events -------------------------------------------------------------

function personalEventInput(value: unknown): PersonalEventInput {
  if (!isObject(value)) throw new AppError("badRequest")
  const allDay = bool(value.allDay)
  const input: PersonalEventInput = {
    title: str(value.title, MAX_TASK_TITLE).trim(),
    description: str(value.description, 8000),
    location: str(value.location, 500).trim(),
    date: date(value.date, false),
    startTime: allDay ? "" : time(value.startTime, false),
    endTime: allDay ? "" : time(value.endTime, false),
    allDay,
    timeZone: timeZone(value.timeZone),
  }
  if (!input.title) throw new AppError("titleRequired")
  if (!allDay && input.endTime <= input.startTime) throw new AppError("invalidTimeRange")
  return input
}

export async function listPersonalEvents(ctx: Ctx, params: unknown): Promise<PersonalEvent[]> {
  const userId = await requireConnected(ctx)
  if (!isObject(params)) throw new AppError("badRequest")
  const range = { from: date(params.from, false), to: date(params.to, false) }
  if (range.to < range.from) throw new AppError("badRequest")
  timeZone(params.timeZone)
  return viaGoogle(() => personal.listEvents(ctx, userId, range))
}

export async function createPersonalEvent(
  ctx: Ctx,
  calendarId: unknown,
  input: unknown,
): Promise<PersonalEvent> {
  const userId = await requireConnected(ctx)
  const value = personalEventInput(input)
  return viaGoogle(() => personal.createEvent(ctx, userId, optionalId(calendarId), value))
}

export async function updatePersonalEvent(
  ctx: Ctx,
  calendarId: unknown,
  id: unknown,
  input: unknown,
): Promise<PersonalEvent> {
  const userId = await requireConnected(ctx)
  const value = personalEventInput(input)
  return viaGoogle(() =>
    personal.updateEvent(ctx, userId, listId(calendarId), str(id, 1024), value),
  )
}

export async function deletePersonalEvent(ctx: Ctx, calendarId: unknown, id: unknown): Promise<void> {
  const userId = await requireConnected(ctx)
  return viaGoogle(() => personal.deleteEvent(ctx, userId, listId(calendarId), str(id, 1024)))
}

// ---- Operators -------------------------------------------------------------------

/** How sync is doing across the platform: failing jobs and people who must reconnect. */
export async function getGoogleSyncHealth(ctx: Ctx): Promise<GoogleSyncHealth> {
  await requireOperator(ctx)
  return { configured: await googleConfigured(ctx), ...(await syncHealth(ctx)) }
}

/** Put every failed job back in the queue and run a first batch now. */
export async function retryFailedGoogleJobs(ctx: Ctx): Promise<GoogleSyncHealth> {
  await requireOperator(ctx)
  if (await retryFailedJobs(ctx)) await drainJobs(ctx, { limit: 25, budgetMs: 15_000 })
  return getGoogleSyncHealth(ctx)
}

// ---- Adding a Google event to a workspace -------------------------------------------

/** One of the person's own Google events, read fresh from one of their own calendars. */
async function ownEvent(ctx: Ctx, userId: string, calendarId: unknown, eventId: unknown) {
  const calendar = (await containersOf(ctx.db, userId)).find(
    (c) => c.kind === "calendar" && c.account_id === null && c.google_id === str(calendarId, 1024),
  )
  if (!calendar) throw new AppError("notFound")
  const g = await googleFor(ctx, userId)
  return viaGoogle(() => calendarApi.get(g, calendar.google_id, str(eventId, 1024)))
}

/**
 * The meeting an administrator would get from one of their Google events: its
 * details as wall-clock times in the workspace's zone, and its guests matched
 * to workspace people by any of their confirmed addresses. `unmatched`: guests
 * who aren't in the workspace (the form says so; they aren't invited).
 */
export async function previewGoogleEventImport(
  ctx: Ctx,
  accountId: string,
  calendarId: unknown,
  eventId: unknown,
): Promise<GoogleEventImport> {
  const userId = await requireConnected(ctx)
  await requireWorkspaceAdmin(ctx, accountId)
  const event = await ownEvent(ctx, userId, calendarId, eventId)
  const fields = importableFields(event, await workspaceZone(ctx, accountId, userId))
  if (!fields) throw new AppError("googleEventNotImportable")

  const people = await all<{ id: string; email: string }>(
    ctx.db,
    `SELECT u.id, lower(u.email) AS email FROM memberships ms
       JOIN users u ON u.id = ms.user_id AND u.active = 1 AND u.deleted_at IS NULL
     WHERE ms.account_id = ?
     UNION
     SELECT ue.user_id AS id, lower(ue.email) AS email FROM user_emails ue
       JOIN memberships ms ON ms.user_id = ue.user_id AND ms.account_id = ?
       JOIN users u ON u.id = ue.user_id AND u.active = 1 AND u.deleted_at IS NULL
     WHERE ue.verified_at IS NOT NULL`,
    accountId,
    accountId,
  )
  const byEmail = new Map(people.map((p) => [p.email, p.id]))
  // Their own addresses: in Taskly, and the Google account they connected.
  const connection = await getConnection(ctx.db, userId)
  const mine = new Set([
    ...people.filter((p) => p.id === userId).map((p) => p.email),
    ...(connection ? [connection.google_email.toLowerCase()] : []),
  ])
  const attendeeIds = new Set<string>()
  const unmatched: string[] = []
  for (const email of eventGuestEmails(event)) {
    const id = byEmail.get(email)
    if (id === userId || mine.has(email)) continue
    if (id) attendeeIds.add(id)
    else unmatched.push(email)
  }
  return { meeting: { ...fields, attendeeIds: [...attendeeIds] }, unmatched }
}

/**
 * Add one of the person's Google events to a workspace as a meeting, with the
 * details they confirmed in the form. The original stays in Google; Taskly
 * shows the meeting in its place to everyone who can see it.
 */
export async function addGoogleEventToWorkspace(
  ctx: Ctx,
  accountId: string,
  calendarId: unknown,
  eventId: unknown,
  input: unknown,
): Promise<Meeting> {
  const userId = await requireConnected(ctx)
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const event = await ownEvent(ctx, userId, calendarId, eventId)
  const meeting = await createMeetingAs(ctx, actor, input)
  await run(ctx.db, "UPDATE meetings SET google_source = ? WHERE id = ?", eventSourceKey(event), meeting.id)
  await queueGoogleSync(ctx, "meeting", accountId, meeting.id)
  return meeting
}
