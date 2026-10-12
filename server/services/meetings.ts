import { AppError } from "@/lib/api/core"
import { canCreateMeeting, canEditMeeting } from "@/lib/permissions"
import type { Meeting, MeetingInput, MeetingOption, Task } from "@/lib/types"
import { requireWorkspace, requireWorkspaceAdmin, type Actor, type Ctx } from "@/server/context"
import { newId } from "@/server/crypto"
import { queueGoogleSync } from "@/server/google/queue"
import {
  all,
  first,
  MEETING_COLUMNS,
  nowIso,
  TASK_COLUMNS,
  toMeeting,
  toTask,
  type MeetingRow,
  type TaskRow,
} from "@/server/db"
import { notify } from "@/server/services/notifications"
import {
  forgetTranslations,
  queueTranslations,
  retryTranslations,
  translationsOf,
} from "@/server/translate/service"
import { assertAssignees, visibleTasks } from "@/server/services/tasks"
import { date, isObject, meetingInput, str, time } from "@/server/validate"

/** Admins see everything; others see meetings they organize or attend. */
export const VISIBLE = `(? OR m.organizer_id = ? OR EXISTS (SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.user_id = ?))`

export const visibleBinds = (actor: Actor) => [actor.role === "administrator" ? 1 : 0, actor.id, actor.id]

/** Meetings on days in `[from, to]` (YYYY-MM-DD) that the user may see. */
export async function listMeetings(
  ctx: Ctx,
  accountId: string,
  params: unknown,
): Promise<Meeting[]> {
  const actor = await requireWorkspace(ctx, accountId)
  if (!isObject(params)) throw new AppError("badRequest")
  const rows = await all<MeetingRow>(
    ctx.db,
    `SELECT ${MEETING_COLUMNS} FROM meetings m
     WHERE m.account_id = ? AND m.date >= ? AND m.date <= ? AND ${VISIBLE}
     ORDER BY m.date, m.start_time`,
    accountId,
    date(params.from, false),
    date(params.to, false),
    ...visibleBinds(actor),
  )
  return rows.map(toMeeting)
}

async function findVisible(
  ctx: Ctx,
  accountId: string,
  id: unknown,
): Promise<{ actor: Actor; meeting: Meeting }> {
  const actor = await requireWorkspace(ctx, accountId)
  const row = await first<MeetingRow>(
    ctx.db,
    `SELECT ${MEETING_COLUMNS} FROM meetings m WHERE m.id = ? AND m.account_id = ? AND ${VISIBLE}`,
    str(id, 100),
    accountId,
    ...visibleBinds(actor),
  )
  if (!row) throw new AppError("meetingNotFound")
  return { actor, meeting: toMeeting(row) }
}

/** One meeting, with its title and agenda in the other language when translated. */
export async function getMeeting(ctx: Ctx, accountId: string, id: unknown): Promise<Meeting> {
  const { meeting } = await findVisible(ctx, accountId, id)
  return { ...meeting, translations: await translationsOf(ctx, "meeting", meeting.id) }
}

/** Run a meeting's translation again (administrators; e.g. after a failure). */
export async function retranslateMeeting(ctx: Ctx, accountId: string, id: unknown): Promise<Meeting> {
  await requireWorkspaceAdmin(ctx, accountId)
  const { meeting } = await findVisible(ctx, accountId, id)
  await retryTranslations(ctx, "meeting", meeting.id)
  return getMeeting(ctx, accountId, meeting.id)
}

/** A meeting by id within the workspace, whoever is asking (internal use). */
export async function findMeeting(
  ctx: Ctx,
  accountId: string,
  id: string,
): Promise<Meeting | null> {
  const row = await first<MeetingRow>(
    ctx.db,
    `SELECT ${MEETING_COLUMNS} FROM meetings m WHERE m.id = ? AND m.account_id = ?`,
    id,
    accountId,
  )
  return row ? toMeeting(row) : null
}

/** Action items: tasks created from this meeting. */
export async function listMeetingTasks(
  ctx: Ctx,
  accountId: string,
  meetingId: unknown,
): Promise<Task[]> {
  const { actor, meeting } = await findVisible(ctx, accountId, meetingId)
  // Members only see the action items assigned to them, and never cancelled
  // ones; private tasks only show to their owner.
  const visible = visibleTasks(actor)
  const rows = await all<TaskRow>(
    ctx.db,
    `SELECT ${TASK_COLUMNS} FROM tasks t
     WHERE t.meeting_id = ? AND t.account_id = ? AND ${visible.sql}
     ORDER BY t.created_at`,
    meeting.id,
    accountId,
    ...visible.binds,
  )
  return rows.map(toTask)
}

/** Meetings the user can link a task to, newest first (task form's "Related to"). */
export async function listMeetingOptions(ctx: Ctx, accountId: string): Promise<MeetingOption[]> {
  const actor = await requireWorkspace(ctx, accountId)
  const rows = await all<MeetingOption & { start_time: string }>(
    ctx.db,
    `SELECT m.id, m.title, m.date, m.start_time FROM meetings m
     WHERE m.account_id = ? AND ${VISIBLE}
     ORDER BY m.date DESC, m.start_time DESC LIMIT 500`,
    accountId,
    ...visibleBinds(actor),
  )
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    date: row.date,
    startTime: row.start_time,
  }))
}

async function validate(
  ctx: Ctx,
  accountId: string,
  raw: unknown,
  previousAttendees: string[] = [],
): Promise<MeetingInput> {
  const input = meetingInput(raw)
  const title = input.title.trim()
  if (!title) throw new AppError("titleRequired")
  if (!input.date || !input.startTime || !input.endTime) throw new AppError("invalidTimeRange")
  const clean = {
    ...input,
    title,
    date: date(input.date, false),
    startTime: time(input.startTime, false),
    endTime: time(input.endTime, false),
    notes: input.notes.trim(),
    location: input.location.trim(),
  }
  if (clean.endTime <= clean.startTime) throw new AppError("invalidTimeRange")
  await assertAssignees(ctx, accountId, clean.attendeeIds, previousAttendees)
  return clean
}

function attendeeStatements(ctx: Ctx, meetingId: string, ids: string[]): D1PreparedStatement[] {
  return [
    ctx.db.prepare("DELETE FROM meeting_attendees WHERE meeting_id = ?").bind(meetingId),
    ctx.db
      .prepare(
        "INSERT INTO meeting_attendees (meeting_id, user_id) SELECT ?, value FROM json_each(?)",
      )
      .bind(meetingId, JSON.stringify(ids)),
  ]
}

export async function createMeeting(ctx: Ctx, accountId: string, raw: unknown): Promise<Meeting> {
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const meeting = await createMeetingAs(ctx, actor, raw)
  await queueGoogleSync(ctx, "meeting", accountId, meeting.id)
  return meeting
}

/**
 * Create a meeting organised by `actor` (an administrator): from the app, or
 * from their Google calendar. Callers queue the Google sync.
 */
export async function createMeetingAs(ctx: Ctx, actor: Actor, raw: unknown): Promise<Meeting> {
  if (!canCreateMeeting(actor)) throw new AppError("forbidden")
  const accountId = actor.account.id
  const input = await validate(ctx, accountId, raw)
  const id = newId("m")
  const now = nowIso()
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO meetings (id, account_id, title, notes, date, start_time, end_time, location,
           organizer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        accountId,
        input.title,
        input.notes,
        input.date,
        input.startTime,
        input.endTime,
        input.location,
        actor.id,
        now,
        now,
      ),
    ...attendeeStatements(ctx, id, input.attendeeIds),
  ])
  const meeting = (await findMeeting(ctx, accountId, id))!
  // Title and agenda in the other language, after the response.
  await queueTranslations(ctx, "meeting", meeting.id)
  await notify(ctx, {
    recipients: meeting.attendeeIds,
    actorId: actor.id,
    event: "meeting_invited",
    accountId,
    data: meetingData(actor, meeting),
    link: meetingLink(meeting),
  })
  return meeting
}

function meetingData(actor: Actor, meeting: Meeting) {
  return {
    actor: actor.user.name,
    workspace: actor.account.name,
    title: meeting.title,
    date: meeting.date,
    time: meeting.startTime,
  }
}

function meetingLink(meeting: Meeting): string {
  return `/w/${meeting.accountId}/calendar?view=week&date=${meeting.date}&meeting=${meeting.id}`
}

export async function updateMeeting(
  ctx: Ctx,
  accountId: string,
  id: unknown,
  raw: unknown,
): Promise<Meeting> {
  const { actor, meeting } = await findVisible(ctx, accountId, id)
  const next = await applyMeetingUpdate(ctx, actor, meeting, raw)
  await queueGoogleSync(ctx, "meeting", accountId, meeting.id)
  return next
}

/**
 * Change a meeting as `actor` (administrators only), from the app or from
 * their Google calendar. Callers queue the Google sync.
 */
export async function applyMeetingUpdate(
  ctx: Ctx,
  actor: Actor,
  meeting: Meeting,
  raw: unknown,
): Promise<Meeting> {
  if (!canEditMeeting(actor)) throw new AppError("forbidden")
  const accountId = actor.account.id
  const input = await validate(ctx, accountId, raw, meeting.attendeeIds)
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE meetings SET title = ?, notes = ?, date = ?, start_time = ?, end_time = ?,
           location = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.title,
        input.notes,
        input.date,
        input.startTime,
        input.endTime,
        input.location,
        nowIso(),
        meeting.id,
      ),
    ...attendeeStatements(ctx, meeting.id, input.attendeeIds),
  ])
  const next = (await findMeeting(ctx, accountId, meeting.id))!
  // Only re-translates a field whose text changed (edits from Google too).
  await queueTranslations(ctx, "meeting", meeting.id)
  const invited = next.attendeeIds.filter((id) => !meeting.attendeeIds.includes(id))
  const common = { actorId: actor.id, accountId, data: meetingData(actor, next), link: meetingLink(next) }
  await notify(ctx, { ...common, recipients: invited, event: "meeting_invited" })
  const changed =
    next.title !== meeting.title ||
    next.date !== meeting.date ||
    next.startTime !== meeting.startTime ||
    next.endTime !== meeting.endTime ||
    next.location !== meeting.location
  if (changed) {
    await notify(ctx, {
      ...common,
      recipients: next.attendeeIds.filter((id) => !invited.includes(id)),
      event: "meeting_updated",
    })
  }
  return next
}

/** Deletes the meeting; its action-item tasks and minutes stay but lose the link. */
export async function deleteMeeting(ctx: Ctx, accountId: string, id: unknown): Promise<void> {
  const { actor, meeting } = await findVisible(ctx, accountId, id)
  await deleteMeetingAs(ctx, actor, meeting)
  await queueGoogleSync(ctx, "meeting", accountId, meeting.id)
}

/** Delete as `actor` (administrators only). Callers queue the Google sync. */
export async function deleteMeetingAs(ctx: Ctx, actor: Actor, meeting: Meeting): Promise<void> {
  if (!canEditMeeting(actor)) throw new AppError("forbidden")
  const accountId = actor.account.id
  await ctx.db.batch([
    // Minutes outlive the meeting; they keep its last title and date.
    ctx.db
      .prepare("UPDATE meeting_minutes SET meeting_title = ?, meeting_date = ? WHERE meeting_id = ?")
      .bind(meeting.title, meeting.date, meeting.id),
    ctx.db.prepare("DELETE FROM meetings WHERE id = ?").bind(meeting.id),
  ])
  await forgetTranslations(ctx, "meeting", meeting.id)
  await notify(ctx, {
    recipients: meeting.attendeeIds,
    actorId: actor.id,
    event: "meeting_cancelled",
    accountId,
    data: meetingData(actor, meeting),
    link: `/w/${accountId}/calendar?view=week&date=${meeting.date}`,
  })
}
