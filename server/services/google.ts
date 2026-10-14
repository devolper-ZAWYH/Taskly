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
  GoogleEventSuggestion,
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
import {
  addEventAsMeeting,
  dismissEvent,
  ownCalendar,
  planImport,
  runGoogleAutoAdd,
  suggestionsFor,
} from "@/server/google/imports"
import * as personal from "@/server/google/personal"
import { viaGoogle } from "@/server/google/personal"
import { drainJobs, enqueue } from "@/server/google/queue"
import { containersOf, getConnection, toContainer, type ContainerRow } from "@/server/google/store"
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

// ---- Adding Google events to a workspace (server/google/imports.ts) --------------

async function ownEvent(ctx: Ctx, userId: string, calendarId: unknown, eventId: unknown) {
  const calendar = await ownCalendar(ctx, userId, str(calendarId, 1024))
  const g = await googleFor(ctx, userId)
  return viaGoogle(() => calendarApi.get(g, calendar.google_id, str(eventId, 1024)))
}

/**
 * The meeting an administrator would get from one of their Google events (fills
 * the form). `unmatched`: guests who aren't in the workspace, so not invited.
 */
export async function previewGoogleEventImport(
  ctx: Ctx,
  accountId: string,
  calendarId: unknown,
  eventId: unknown,
): Promise<GoogleEventImport> {
  const userId = await requireConnected(ctx)
  await requireWorkspaceAdmin(ctx, accountId)
  const plan = await planImport(ctx, accountId, userId, await ownEvent(ctx, userId, calendarId, eventId))
  if (!plan) throw new AppError("googleEventNotImportable")
  return { meeting: plan.meeting, unmatched: plan.unmatched }
}

/** Add one Google event as a meeting, with the details confirmed in the form. */
export async function addGoogleEventToWorkspace(
  ctx: Ctx,
  accountId: string,
  calendarId: unknown,
  eventId: unknown,
  input: unknown,
): Promise<Meeting> {
  const userId = await requireConnected(ctx)
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  return addEventAsMeeting(ctx, actor, await ownEvent(ctx, userId, calendarId, eventId), input)
}

/** Their Google events with other people from this workspace, not added yet (Calendar page). */
export async function listGoogleEventSuggestions(ctx: Ctx, accountId: string): Promise<GoogleEventSuggestion[]> {
  const userId = await requireConnected(ctx)
  await requireWorkspaceAdmin(ctx, accountId)
  return viaGoogle(() => suggestionsFor(ctx, accountId, userId))
}

/** "Add" / "Add all" on suggestions: each as planned, without the form. */
export async function addSuggestedGoogleEvents(
  ctx: Ctx,
  accountId: string,
  items: unknown,
): Promise<{ added: number; skipped: number }> {
  const userId = await requireConnected(ctx)
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) throw new AppError("badRequest")
  let added = 0
  let skipped = 0
  for (const item of items) {
    if (!isObject(item)) throw new AppError("badRequest")
    const event = await ownEvent(ctx, userId, item.calendarId, item.eventId)
    const plan = await planImport(ctx, accountId, userId, event)
    try {
      if (!plan) throw new AppError("googleEventNotImportable")
      await addEventAsMeeting(ctx, actor, event, plan.meeting)
      added++
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      skipped++
    }
  }
  return { added, skipped }
}

/** "Not a work meeting": stop suggesting (and auto-adding) it in this workspace. */
export async function dismissGoogleEventSuggestion(
  ctx: Ctx,
  accountId: string,
  calendarId: unknown,
  eventId: unknown,
): Promise<void> {
  const userId = await requireConnected(ctx)
  await requireWorkspaceAdmin(ctx, accountId)
  await dismissEvent(ctx, userId, accountId, await ownEvent(ctx, userId, calendarId, eventId))
}

/**
 * Settings → Google: add this calendar's work meetings to a workspace
 * automatically (one where they're an administrator), or stop (null).
 * Runs once straight away, then hourly.
 */
export async function setGoogleCalendarAutoAdd(
  ctx: Ctx,
  calendarId: unknown,
  accountId: unknown,
): Promise<GoogleContainer[]> {
  const userId = await requireConnected(ctx)
  const calendar = await ownCalendar(ctx, userId, str(calendarId, 1024))
  const target = accountId === null ? null : str(accountId, 100)
  if (target) await requireWorkspaceAdmin(ctx, target)
  await run(
    ctx.db,
    "UPDATE google_containers SET auto_account_id = ? WHERE user_id = ? AND kind = 'calendar' AND google_id = ?",
    target,
    userId,
    calendar.google_id,
  )
  if (target) {
    ctx.waitUntil(
      runGoogleAutoAdd(ctx, new Date(), { userId, calendarId: calendar.google_id }).catch((error) =>
        console.error("google auto-add failed", error),
      ),
    )
  }
  return (await containersOf(ctx.db, userId)).map(toContainer)
}
