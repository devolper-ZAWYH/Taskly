/**
 * Pure conversions between Taskly items and their Google copies, both ways.
 * No I/O and only type imports, so `node --test` can run it directly.
 *
 * Only the fields below sync in both directions. Everything else Taskly knows
 * (due time, priority, people, a link back) goes into a footer under
 * `FOOTER_MARK`, which inbound sync ignores.
 */
import type { Meeting, Task, TaskStatus } from "@/lib/types"

/** Everything from this line down in a task note or event description is Taskly's. */
export const FOOTER_MARK = "⸻ Taskly ⸻"

/** Fields of a workspace task that sync both ways. */
export type TaskFields = {
  title: string
  description: string
  dueDate: string
  done: boolean
}

/** Fields of a workspace meeting that sync both ways. */
export type MeetingFields = {
  title: string
  notes: string
  date: string
  startTime: string
  endTime: string
  location: string
}

/** The parts of a Google Tasks `Task` resource Taskly reads. */
export type GoogleTask = {
  id: string
  etag?: string
  title?: string
  notes?: string
  status?: "needsAction" | "completed"
  /** RFC 3339; only the date part is meaningful. */
  due?: string | null
  completed?: string | null
  updated?: string
  deleted?: boolean
  hidden?: boolean
  parent?: string
  webViewLink?: string
}

export type GoogleEventTime = { dateTime?: string | null; date?: string | null; timeZone?: string }

/** The parts of a Google Calendar `Event` resource Taskly reads. */
export type GoogleEvent = {
  id: string
  etag?: string
  status?: "confirmed" | "tentative" | "cancelled"
  summary?: string
  description?: string
  location?: string
  start?: GoogleEventTime
  end?: GoogleEventTime
  recurrence?: string[]
  recurringEventId?: string
  updated?: string
  htmlLink?: string
  organizer?: { email?: string; self?: boolean }
  attendees?: { email?: string; self?: boolean; resource?: boolean; responseStatus?: string }[]
  /** The same for every guest's copy of the event. */
  iCalUID?: string
  /** For an occurrence of a repeating event: when it was originally scheduled. */
  originalStartTime?: GoogleEventTime
  guestsCanModify?: boolean
  /** "default", or a special kind (birthday, focusTime, outOfOffice, fromGmail, …). */
  eventType?: string
  extendedProperties?: { private?: Record<string, string> }
}

// Taskly's own input limits (server/validate.ts).
const MAX_TITLE = 300
const MAX_TEXT = 20_000
const MAX_LOCATION = 500

// ---- Text --------------------------------------------------------------------

const HTML_HINT = /<\/?(br|p|div|span|b|i|u|a|ul|ol|li|strong|em)\b[^>]*>/i

/** Google Calendar's web editor stores descriptions as HTML; turn that back into plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|div|li|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m: string, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
}

/** The person-written part of a note: plain text, without Taskly's footer. */
export function noteBody(text: string | undefined | null): string {
  if (!text) return ""
  const plain = (HTML_HINT.test(text) ? htmlToText(text) : text).replace(/\r\n?/g, "\n")
  const lines = plain.split("\n")
  const mark = lines.findIndex((line) => line.trim() === FOOTER_MARK)
  return (mark === -1 ? lines : lines.slice(0, mark)).join("\n").trim()
}

/** `body`, then Taskly's footer lines under the mark. */
export function withFooter(body: string, footer: string[]): string {
  if (footer.length === 0) return body
  return `${body}${body ? "\n\n" : ""}${FOOTER_MARK}\n${footer.join("\n")}`
}

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

// ---- Tasks -------------------------------------------------------------------

export function taskFields(task: Task): TaskFields {
  return {
    title: task.title,
    description: task.description,
    dueDate: task.dueDate,
    done: task.status === "completed",
  }
}

export function googleTaskFields(task: GoogleTask): TaskFields {
  return {
    title: clip((task.title ?? "").trim(), MAX_TITLE),
    description: clip(noteBody(task.notes), MAX_TEXT),
    dueDate: task.due ? task.due.slice(0, 10) : "",
    done: task.status === "completed",
  }
}

/** Request body for inserting or patching the Google copy of a task. */
export function googleTaskBody(fields: TaskFields, footer: string[]) {
  return {
    title: fields.title,
    notes: withFooter(fields.description, footer),
    due: fields.dueDate ? `${fields.dueDate}T00:00:00.000Z` : null,
    status: fields.done ? ("completed" as const) : ("needsAction" as const),
    ...(fields.done ? {} : { completed: null }),
  }
}

/**
 * The Taskly task a Google copy belongs to, from the "Open in Taskly" link in
 * its footer (`…/tasks?task=<id>`), or null when it isn't one of Taskly's copies.
 */
export function footerTaskId(notes: string | undefined | null): string | null {
  if (!notes) return null
  const mark = notes.indexOf(FOOTER_MARK)
  if (mark === -1) return null
  return /\/tasks\?task=(t-[\w-]+)/.exec(notes.slice(mark))?.[1] ?? null
}

/** Taskly status after Google says done / not done. Reopening a completed task makes it open. */
export function statusFromDone(done: boolean, current: TaskStatus): TaskStatus {
  if (done) return "completed"
  return current === "completed" ? "open" : current
}

// ---- Meetings ----------------------------------------------------------------

export function meetingFields(meeting: Meeting): MeetingFields {
  return {
    title: meeting.title,
    notes: meeting.notes,
    date: meeting.date,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    location: meeting.location,
  }
}

/** Wall-clock date (`YYYY-MM-DD`) and time (`HH:MM`) of `at` in `zone`. */
export function wallClock(at: Date, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` }
}

/** Whether a Google event can be a Taskly meeting: timed, single-day, not repeating. */
export function isMeetingShaped(event: GoogleEvent, zone: string): boolean {
  return eventFields(event, zone) !== null
}

/**
 * The synced fields of an event, as wall-clock times in the workspace `zone`,
 * or null when it can't be a Taskly meeting (all-day, multi-day, repeating,
 * cancelled, or ending before it starts).
 */
export function eventFields(event: GoogleEvent, zone: string): MeetingFields | null {
  if (event.status === "cancelled") return null
  if (event.recurrence?.length || event.recurringEventId) return null
  if (!event.start?.dateTime || !event.end?.dateTime) return null
  const start = wallClock(new Date(event.start.dateTime), zone)
  const end = wallClock(new Date(event.end.dateTime), zone)
  if (start.date !== end.date || end.time <= start.time) return null
  return {
    title: clip((event.summary ?? "").trim(), MAX_TITLE),
    notes: clip(noteBody(event.description), MAX_TEXT),
    date: start.date,
    startTime: start.time,
    endTime: end.time,
    location: clip((event.location ?? "").trim(), MAX_LOCATION),
  }
}

/** Request body for inserting the Google copy of a meeting (see `eventPatchBody`). */
export function googleEventBody(
  fields: MeetingFields,
  zone: string,
  footer: string[],
  ids: { meetingId: string; accountId: string },
) {
  return {
    summary: fields.title,
    description: withFooter(fields.notes, footer),
    location: fields.location,
    start: { dateTime: `${fields.date}T${fields.startTime}:00`, timeZone: zone },
    end: { dateTime: `${fields.date}T${fields.endTime}:00`, timeZone: zone },
    extendedProperties: {
      private: { tasklyMeetingId: ids.meetingId, tasklyAccountId: ids.accountId },
    },
  }
}

/**
 * The same, for patching an existing copy: also clears an all-day date or a
 * repeat rule someone added in Google (Taskly meetings are neither).
 */
export function eventPatchBody(
  fields: MeetingFields,
  zone: string,
  footer: string[],
  ids: { meetingId: string; accountId: string },
) {
  const body = googleEventBody(fields, zone, footer, ids)
  return {
    ...body,
    start: { ...body.start, date: null },
    end: { ...body.end, date: null },
    recurrence: [],
  }
}

/** One task linked to a meeting, as its Google copy lists it. */
export type ActionItem = { title: string; done: boolean; names: string[]; due: string }

/**
 * "• Title — Omar, Sara, due 2026-10-20" (done ones ticked and without a due
 * date), at most `max` lines, then "+N more". `words.dueOn` holds `{date}` and
 * `words.more` holds `{count}`, in the reader's language.
 */
export function actionItemLines(
  items: ActionItem[],
  words: { dueOn: string; more: string },
  max: number,
): string[] {
  const lines = items.slice(0, max).map((item) => {
    const people = item.names.length > 0 ? ` — ${item.names.join(", ")}` : ""
    const due = item.due && !item.done ? words.dueOn.replace("{date}", item.due) : ""
    return `${item.done ? "✓" : "•"} ${item.title}${people}${due}`
  })
  if (items.length > max) lines.push(words.more.replace("{count}", String(items.length - max)))
  return lines
}

/**
 * Which event a meeting was added from, the same in every guest's calendar and
 * after the organiser moves it: its iCalUID, plus "#<original start>" for one
 * occurrence of a repeating event.
 */
export function eventSourceKey(event: GoogleEvent): string {
  const uid = event.iCalUID ?? event.id
  const at = event.originalStartTime
  if (!at && !event.recurringEventId) return uid
  const start = at?.dateTime ? new Date(at.dateTime).toISOString() : (at?.date ?? event.start?.dateTime ?? "")
  return `${uid}#${start}`
}

/** Whoever is reading the event said they won't go. */
export function declinedBySelf(event: GoogleEvent): boolean {
  return (event.attendees ?? []).some((a) => a.self && a.responseStatus === "declined")
}

/** The other people on an event (organiser and guests; not rooms, not whoever is reading it), lowercased. */
export function eventGuestEmails(event: GoogleEvent): string[] {
  const emails = [
    event.organizer?.self ? undefined : event.organizer?.email,
    ...(event.attendees ?? []).filter((a) => !a.resource && !a.self).map((a) => a.email),
  ]
  return [...new Set(emails.filter((e): e is string => Boolean(e)).map((e) => e.trim().toLowerCase()))]
}

/**
 * Meeting fields for adding one event (or one occurrence of a repeating one)
 * to a workspace. Null for Taskly's own copies of meetings (in a calendar
 * someone subscribed to): those are meetings already.
 */
export function importableFields(event: GoogleEvent, zone: string): MeetingFields | null {
  if (event.extendedProperties?.private?.tasklyMeetingId) return null
  return eventFields({ ...event, recurrence: undefined, recurringEventId: undefined }, zone)
}
