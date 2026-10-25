/**
 * The person's own Google Tasks and Calendar events. Google is the source of
 * truth, so these are read and written live (nothing is stored in Taskly):
 * a change in Google shows the next time Taskly asks, and an edit in Taskly
 * is an edit in Google.
 */
import { AppError } from "@/lib/api/core"
import type { PersonalEvent, PersonalEventInput, PersonalTask, PersonalTaskInput } from "@/lib/types"
import type { Ctx } from "@/server/context"
import { all } from "@/server/db"
import { calendarApi, tasksApi } from "@/server/google/apis"
import { GoogleError, googleFor, isGone, type Google } from "@/server/google/client"
import { refreshPersonalContainers } from "@/server/google/containers"
import { eventSourceKey, type GoogleEvent, type GoogleTask } from "@/server/google/mapping"
import { personalContainer, type ContainerRow } from "@/server/google/store"

/**
 * Turn Google failures into errors the app can show. Gone → not found; refused →
 * forbidden; anything else (rate limits, outages, network) → "try again".
 */
export async function viaGoogle<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof AppError) throw error
    if (error instanceof GoogleError) {
      if (isGone(error)) throw new AppError("notFound")
      if ((error.status === 403 || error.status === 400) && !error.retryable) {
        throw new AppError(error.status === 403 ? "forbidden" : "badRequest")
      }
    }
    console.error("google request failed", error)
    throw new AppError("googleUnavailable")
  }
}

/** Their selected personal lists or calendars, learning them from Google the first time. */
async function selected(ctx: Ctx, g: Google, kind: "tasklist" | "calendar"): Promise<ContainerRow[]> {
  const load = () =>
    all<ContainerRow>(
      ctx.db,
      `SELECT * FROM google_containers WHERE user_id = ? AND kind = ? AND account_id IS NULL
       ORDER BY is_primary DESC, title COLLATE NOCASE`,
      g.userId,
      kind,
    )
  let rows = await load()
  if (rows.length === 0) {
    await refreshPersonalContainers(ctx, g, g.userId)
    rows = await load()
  }
  return rows.filter((row) => row.selected === 1)
}

/** The container to write into: the given personal one, or their default/primary. */
async function target(ctx: Ctx, g: Google, kind: "tasklist" | "calendar", id: string | null) {
  const row = await personalContainer(ctx.db, g.userId, kind, id ?? "primary")
  if (row) return row
  if (id === null) {
    await refreshPersonalContainers(ctx, g, g.userId)
    const fresh = await personalContainer(ctx.db, g.userId, kind, "primary")
    if (fresh) return fresh
  }
  // Only their own lists/calendars: workspace copies change through Taskly.
  throw new AppError("notFound")
}

/** Insert bodies leave fields out rather than sending null (null clears, in a patch). */
function withoutNulls<T extends object>(body: T): T {
  return JSON.parse(JSON.stringify(body, (_key, value) => (value === null ? undefined : value)))
}

// ---- Tasks -------------------------------------------------------------------

function toPersonalTask(task: GoogleTask, list: ContainerRow): PersonalTask {
  return {
    id: task.id,
    tasklistId: list.google_id,
    tasklistTitle: list.title,
    title: task.title ?? "",
    notes: task.notes ?? "",
    dueDate: task.due ? task.due.slice(0, 10) : "",
    completed: task.status === "completed",
    completedAt: task.completed ?? null,
    updatedAt: task.updated ?? "",
    webLink: task.webViewLink ?? null,
  }
}

/** Open tasks first (soonest due first, undated last), then completed, newest first. */
function byDue(a: PersonalTask, b: PersonalTask): number {
  if (a.completed !== b.completed) return a.completed ? 1 : -1
  if (a.completed) return (b.completedAt ?? "").localeCompare(a.completedAt ?? "")
  return (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.title.localeCompare(b.title)
}

export async function listTasks(
  ctx: Ctx,
  userId: string,
  showCompleted: boolean,
): Promise<PersonalTask[]> {
  const g = await googleFor(ctx, userId)
  const lists = await selected(ctx, g, "tasklist")
  const results = await Promise.all(
    lists.map(async (list) => {
      try {
        const items = await tasksApi.list(g, list.google_id, {
          showCompleted,
          showHidden: showCompleted,
        })
        return items.filter((item) => !item.deleted).map((item) => toPersonalTask(item, list))
      } catch (error) {
        if (isGone(error)) return [] // deleted in Google since the last refresh
        throw error
      }
    }),
  )
  return results.flat().sort(byDue)
}

const taskBody = (input: Partial<PersonalTaskInput>) => ({
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...(input.notes !== undefined ? { notes: input.notes } : {}),
  ...(input.dueDate !== undefined
    ? { due: input.dueDate ? `${input.dueDate}T00:00:00.000Z` : null }
    : {}),
  ...(input.completed !== undefined
    ? input.completed
      ? { status: "completed" }
      : { status: "needsAction", completed: null }
    : {}),
})

export async function createTask(
  ctx: Ctx,
  userId: string,
  tasklistId: string | null,
  input: PersonalTaskInput,
): Promise<PersonalTask> {
  const g = await googleFor(ctx, userId)
  const list = await target(ctx, g, "tasklist", tasklistId)
  return toPersonalTask(await tasksApi.insert(g, list.google_id, withoutNulls(taskBody(input))), list)
}

export async function updateTask(
  ctx: Ctx,
  userId: string,
  tasklistId: string,
  id: string,
  patch: Partial<PersonalTaskInput>,
): Promise<PersonalTask> {
  const g = await googleFor(ctx, userId)
  const list = await target(ctx, g, "tasklist", tasklistId)
  return toPersonalTask(await tasksApi.patch(g, list.google_id, id, taskBody(patch)), list)
}

export async function deleteTask(
  ctx: Ctx,
  userId: string,
  tasklistId: string,
  id: string,
): Promise<void> {
  const g = await googleFor(ctx, userId)
  const list = await target(ctx, g, "tasklist", tasklistId)
  await tasksApi.delete(g, list.google_id, id)
}

// ---- Events ------------------------------------------------------------------

const writable = (calendar: ContainerRow) =>
  calendar.access_role === "owner" || calendar.access_role === "writer"

function toPersonalEvent(event: GoogleEvent, calendar: ContainerRow): PersonalEvent {
  const ownEvent =
    !event.organizer ||
    event.organizer.self === true ||
    event.organizer.email === calendar.google_id ||
    event.guestsCanModify === true
  return {
    id: event.id,
    calendarId: calendar.google_id,
    calendarTitle: calendar.title,
    color: calendar.color,
    title: event.summary ?? "",
    description: event.description ?? "",
    location: event.location ?? "",
    allDay: Boolean(event.start?.date),
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    recurring: Boolean(event.recurringEventId),
    editable:
      writable(calendar) && ownEvent && (!event.eventType || event.eventType === "default"),
    htmlLink: event.htmlLink ?? null,
  }
}

function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Occurrences on their selected calendars around `[from, to]`. The window is
 * padded a day each side so any zone is covered; the browser places events
 * in its own time zone.
 */
export async function listEvents(
  ctx: Ctx,
  userId: string,
  range: { from: string; to: string },
): Promise<PersonalEvent[]> {
  const g = await googleFor(ctx, userId)
  const calendars = await selected(ctx, g, "calendar")
  const timeMin = `${shiftDate(range.from, -1)}T00:00:00Z`
  const timeMax = `${shiftDate(range.to, 2)}T00:00:00Z`
  const results = await Promise.all(
    calendars.map(async (calendar) => {
      try {
        const { items } = await calendarApi.events(g, calendar.google_id, {
          singleEvents: true,
          orderBy: "startTime",
          timeMin,
          timeMax,
        })
        return items
          .filter((event) => event.status !== "cancelled")
          .map((event) => ({ event: toPersonalEvent(event, calendar), source: eventSourceKey(event) }))
      } catch (error) {
        if (isGone(error)) return []
        throw error
      }
    }),
  )
  const found = results.flat()
  // Events added to a workspace show as that meeting instead.
  const added = await addedAsMeetings(ctx, userId, found.map((item) => item.source))
  return found
    .filter((item) => !added.has(item.source))
    .map((item) => item.event)
    .sort((a, b) => a.start.localeCompare(b.start))
}

/** Which of these events became meetings this person can see (canViewMeeting) in an active workspace. */
async function addedAsMeetings(ctx: Ctx, userId: string, sources: string[]): Promise<Set<string>> {
  if (sources.length === 0) return new Set()
  const rows = await all<{ google_source: string }>(
    ctx.db,
    `SELECT DISTINCT m.google_source FROM meetings m
     JOIN memberships ms ON ms.account_id = m.account_id AND ms.user_id = ?
     JOIN accounts a ON a.id = m.account_id AND a.active = 1
     WHERE m.google_source IN (SELECT value FROM json_each(?))
       AND (ms.role = 'administrator' OR m.organizer_id = ?
         OR EXISTS (SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.user_id = ?))`,
    userId,
    JSON.stringify([...new Set(sources)]),
    userId,
    userId,
  )
  return new Set(rows.map((row) => row.google_source))
}

function eventBody(input: PersonalEventInput) {
  if (input.allDay) {
    // Google's all-day end date is exclusive.
    return {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: { date: input.date, dateTime: null },
      end: { date: shiftDate(input.date, 1), dateTime: null },
    }
  }
  return {
    summary: input.title,
    description: input.description,
    location: input.location,
    start: { dateTime: `${input.date}T${input.startTime}:00`, timeZone: input.timeZone, date: null },
    end: { dateTime: `${input.date}T${input.endTime}:00`, timeZone: input.timeZone, date: null },
  }
}

async function writableCalendar(ctx: Ctx, g: Google, calendarId: string | null) {
  const calendar = await target(ctx, g, "calendar", calendarId)
  if (!writable(calendar)) throw new AppError("forbidden")
  return calendar
}

export async function createEvent(
  ctx: Ctx,
  userId: string,
  calendarId: string | null,
  input: PersonalEventInput,
): Promise<PersonalEvent> {
  const g = await googleFor(ctx, userId)
  const calendar = await writableCalendar(ctx, g, calendarId)
  const created = await calendarApi.insert(g, calendar.google_id, withoutNulls(eventBody(input)))
  return toPersonalEvent(created, calendar)
}

/** Changes this event, or this one occurrence of a repeating event. */
export async function updateEvent(
  ctx: Ctx,
  userId: string,
  calendarId: string,
  id: string,
  input: PersonalEventInput,
): Promise<PersonalEvent> {
  const g = await googleFor(ctx, userId)
  const calendar = await writableCalendar(ctx, g, calendarId)
  return toPersonalEvent(await calendarApi.patch(g, calendar.google_id, id, eventBody(input)), calendar)
}

export async function deleteEvent(
  ctx: Ctx,
  userId: string,
  calendarId: string,
  id: string,
): Promise<void> {
  const g = await googleFor(ctx, userId)
  const calendar = await writableCalendar(ctx, g, calendarId)
  await calendarApi.delete(g, calendar.google_id, id)
}
