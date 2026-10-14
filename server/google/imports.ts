/**
 * Turning people's own Google events into workspace meetings, so they get
 * minutes and action items. Three ways in, with the same rules:
 *   - by hand: "Add to workspace" on one event (an administrator confirms the form);
 *   - suggestions: events that include someone else from the workspace,
 *     offered on the Calendar page with Add / Add all / "Not a work meeting";
 *   - automatically: a calendar the administrator marked in Settings → Google,
 *     checked every hour (runGoogleAutoAdd).
 * The meeting remembers the event (meetings.google_source); the original
 * stays in Google and Taskly shows the meeting in its place.
 */
import { AppError } from "@/lib/api/core"
import type { GoogleEventSuggestion, Meeting, MeetingInput } from "@/lib/types"
import { actorFor, type Actor, type Ctx } from "@/server/context"
import { all, first, nowIso, run } from "@/server/db"
import { calendarApi } from "@/server/google/apis"
import { googleFor, isGone } from "@/server/google/client"
import {
  declinedBySelf,
  eventGuestEmails,
  eventSourceKey,
  importableFields,
  type GoogleEvent,
} from "@/server/google/mapping"
import { workspaceZone } from "@/server/google/people"
import { queueGoogleSync } from "@/server/google/queue"
import { containersOf, getConnection, type ContainerRow } from "@/server/google/store"
import { createMeetingAs } from "@/server/services/meetings"

export type ImportPlan = { meeting: MeetingInput; unmatched: string[]; names: string[] }

/** How far ahead suggestions and the automatic rule look; suggestions also look a week back. */
const AHEAD_DAYS = 14
const BACK_DAYS = 7
/** Per calendar, per hourly run. */
const AUTO_LIMIT = 25

/** The person's own calendars (not the "Taskly · …" ones), by id. */
export async function ownCalendar(ctx: Ctx, userId: string, calendarId: string): Promise<ContainerRow> {
  const calendar = (await containersOf(ctx.db, userId)).find(
    (c) => c.kind === "calendar" && c.account_id === null && c.google_id === calendarId,
  )
  if (!calendar) throw new AppError("notFound")
  return calendar
}

/**
 * The meeting an event would become in `accountId`: wall-clock times in the
 * workspace's zone, guests matched to its people by any confirmed address.
 * Null when it can't be a meeting (all-day, multi-day, cancelled).
 */
export async function planImport(
  ctx: Ctx,
  accountId: string,
  userId: string,
  event: GoogleEvent,
): Promise<ImportPlan | null> {
  const fields = importableFields(event, await workspaceZone(ctx, accountId, userId))
  if (!fields) return null
  const people = await all<{ id: string; email: string; name: string }>(
    ctx.db,
    `SELECT u.id, lower(u.email) AS email, u.name FROM memberships ms
       JOIN users u ON u.id = ms.user_id AND u.active = 1 AND u.deleted_at IS NULL
     WHERE ms.account_id = ?
     UNION
     SELECT ue.user_id AS id, lower(ue.email) AS email, u.name FROM user_emails ue
       JOIN memberships ms ON ms.user_id = ue.user_id AND ms.account_id = ?
       JOIN users u ON u.id = ue.user_id AND u.active = 1 AND u.deleted_at IS NULL
     WHERE ue.verified_at IS NOT NULL`,
    accountId,
    accountId,
  )
  const byEmail = new Map(people.map((p) => [p.email, p]))
  // Their own addresses: in Taskly, and the Google account they connected.
  const connection = await getConnection(ctx.db, userId)
  const mine = new Set([
    ...people.filter((p) => p.id === userId).map((p) => p.email),
    ...(connection ? [connection.google_email.toLowerCase()] : []),
  ])
  const attendees = new Map<string, string>()
  const unmatched: string[] = []
  for (const email of eventGuestEmails(event)) {
    const person = byEmail.get(email)
    if (person?.id === userId || mine.has(email)) continue
    if (person) attendees.set(person.id, person.name)
    else unmatched.push(email)
  }
  return {
    meeting: { ...fields, attendeeIds: [...attendees.keys()] },
    unmatched,
    names: [...attendees.values()],
  }
}

/**
 * Create the meeting as `actor` and remember the event. Two adds of the same
 * event can race (a click and the hourly rule): the second is undone and
 * reported as `googleEventAlreadyAdded`.
 */
export async function addEventAsMeeting(
  ctx: Ctx,
  actor: Actor,
  event: GoogleEvent,
  input: unknown,
): Promise<Meeting> {
  const accountId = actor.account.id
  const source = eventSourceKey(event)
  if (await alreadyAdded(ctx, accountId, source)) throw new AppError("googleEventAlreadyAdded")
  const meeting = await createMeetingAs(ctx, actor, input)
  try {
    await run(ctx.db, "UPDATE meetings SET google_source = ? WHERE id = ?", source, meeting.id)
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error
    await run(ctx.db, "DELETE FROM meetings WHERE id = ?", meeting.id)
    throw new AppError("googleEventAlreadyAdded")
  }
  await queueGoogleSync(ctx, "meeting", accountId, meeting.id)
  return meeting
}

async function alreadyAdded(ctx: Ctx, accountId: string, source: string): Promise<boolean> {
  return Boolean(
    await first(ctx.db, "SELECT 1 FROM meetings WHERE account_id = ? AND google_source = ?", accountId, source),
  )
}

async function dismissedSources(ctx: Ctx, userId: string, accountId: string): Promise<Set<string>> {
  const rows = await all<{ google_source: string }>(
    ctx.db,
    "SELECT google_source FROM google_event_dismissals WHERE user_id = ? AND account_id = ?",
    userId,
    accountId,
  )
  return new Set(rows.map((row) => row.google_source))
}

async function addedSources(ctx: Ctx, accountId: string, sources: string[]): Promise<Set<string>> {
  if (sources.length === 0) return new Set()
  const rows = await all<{ google_source: string }>(
    ctx.db,
    `SELECT google_source FROM meetings
     WHERE account_id = ? AND google_source IN (SELECT value FROM json_each(?))`,
    accountId,
    JSON.stringify([...new Set(sources)]),
  )
  return new Set(rows.map((row) => row.google_source))
}

const dayIso = (at: Date, days: number) => new Date(at.getTime() + days * 86_400_000).toISOString()

/** Events in one of their calendars between `from` and `to`, one row per occurrence. */
async function eventsIn(ctx: Ctx, userId: string, calendarId: string, from: string, to: string) {
  const g = await googleFor(ctx, userId)
  try {
    const { items } = await calendarApi.events(g, calendarId, {
      singleEvents: true,
      orderBy: "startTime",
      timeMin: from,
      timeMax: to,
    })
    return items
  } catch (error) {
    if (isGone(error)) return []
    throw error
  }
}

/**
 * Work meetings worth adding: events that can be meetings, include at least
 * one other person from the workspace, and weren't added, dismissed or
 * declined. `events`: [calendarId, event] pairs.
 */
async function candidates(
  ctx: Ctx,
  accountId: string,
  userId: string,
  events: [string, GoogleEvent][],
): Promise<{ calendarId: string; event: GoogleEvent; source: string; plan: ImportPlan }[]> {
  const live = events.filter(([, e]) => e.status !== "cancelled" && !declinedBySelf(e))
  const sources = live.map(([, e]) => eventSourceKey(e))
  const [added, dismissed] = await Promise.all([
    addedSources(ctx, accountId, sources),
    dismissedSources(ctx, userId, accountId),
  ])
  const seen = new Set<string>()
  const found = []
  for (const [calendarId, event] of live) {
    const source = eventSourceKey(event)
    // The same event can sit in two of their calendars.
    if (added.has(source) || dismissed.has(source) || seen.has(source)) continue
    seen.add(source)
    const plan = await planImport(ctx, accountId, userId, event)
    if (plan && plan.meeting.attendeeIds.length > 0) found.push({ calendarId, event, source, plan })
  }
  return found
}

/** Suggestions for the Calendar page: their shown calendars, a week back to two weeks ahead. */
export async function suggestionsFor(ctx: Ctx, accountId: string, userId: string): Promise<GoogleEventSuggestion[]> {
  const calendars = (await containersOf(ctx.db, userId)).filter(
    (c) => c.kind === "calendar" && c.account_id === null && c.selected === 1,
  )
  const now = new Date()
  const lists = await Promise.all(
    calendars.map(async (c) =>
      (await eventsIn(ctx, userId, c.google_id, dayIso(now, -BACK_DAYS), dayIso(now, AHEAD_DAYS))).map(
        (e): [string, GoogleEvent] => [c.google_id, e],
      ),
    ),
  )
  const found = await candidates(ctx, accountId, userId, lists.flat())
  return found
    .map(({ calendarId, event, plan }) => ({
      calendarId,
      eventId: event.id,
      title: plan.meeting.title,
      date: plan.meeting.date,
      startTime: plan.meeting.startTime,
      endTime: plan.meeting.endTime,
      people: plan.names,
      outsiders: plan.unmatched.length,
    }))
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
}

/** "Not a work meeting": don't suggest it (or add it automatically) for this workspace again. */
export async function dismissEvent(ctx: Ctx, userId: string, accountId: string, event: GoogleEvent) {
  await run(
    ctx.db,
    `INSERT INTO google_event_dismissals (user_id, account_id, google_source, created_at)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    userId,
    accountId,
    eventSourceKey(event),
    nowIso(),
  )
}

/**
 * The hourly automatic rule: for each calendar someone marked, add the coming
 * two weeks' work meetings to the chosen workspace, as long as they're still
 * an administrator there. One person's failure doesn't stop the others.
 */
export async function runGoogleAutoAdd(ctx: Ctx, at: Date, only?: { userId: string; calendarId: string }): Promise<number> {
  const rules = await all<{ user_id: string; google_id: string; auto_account_id: string }>(
    ctx.db,
    `SELECT c.user_id, c.google_id, c.auto_account_id FROM google_containers c
       JOIN google_connections gc ON gc.user_id = c.user_id AND gc.state = 'active'
       JOIN memberships ms ON ms.user_id = c.user_id AND ms.account_id = c.auto_account_id
         AND ms.role = 'administrator'
       JOIN accounts a ON a.id = c.auto_account_id AND a.active = 1
       JOIN users u ON u.id = c.user_id AND u.active = 1 AND u.deleted_at IS NULL
     WHERE c.kind = 'calendar' AND c.account_id IS NULL AND c.auto_account_id IS NOT NULL
       AND (? IS NULL OR (c.user_id = ? AND c.google_id = ?))`,
    only ? 1 : null,
    only?.userId ?? null,
    only?.calendarId ?? null,
  )
  let added = 0
  for (const rule of rules) {
    try {
      const actor = await actorFor(ctx, rule.user_id, rule.auto_account_id)
      if (!actor) continue
      const events = await eventsIn(ctx, rule.user_id, rule.google_id, at.toISOString(), dayIso(at, AHEAD_DAYS))
      const found = await candidates(
        ctx,
        rule.auto_account_id,
        rule.user_id,
        events.map((e): [string, GoogleEvent] => [rule.google_id, e]),
      )
      for (const item of found.slice(0, AUTO_LIMIT)) {
        try {
          await addEventAsMeeting(ctx, actor, item.event, item.plan.meeting)
          added++
        } catch (error) {
          if (!(error instanceof AppError && error.code === "googleEventAlreadyAdded")) throw error
        }
      }
    } catch (error) {
      console.error(`google auto-add for ${rule.user_id} failed`, error)
    }
  }
  return added
}
