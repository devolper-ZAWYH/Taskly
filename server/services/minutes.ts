/**
 * Meeting minutes: each person's own notes on a meeting they can see, one set
 * per person per meeting. The author chooses who reads them (only themselves,
 * everyone in the workspace, or selected people); nobody else edits them.
 * Minutes outlive their meeting, keeping its last known title and date.
 */
import { AppError } from "@/lib/api/core"
import { canEditMinutes, canViewMinutes, canWriteMinutes } from "@/lib/permissions"
import {
  MINUTES_SCOPES,
  type FieldTranslation,
  type MeetingMinutes,
  type MinutesInput,
  type Page,
} from "@/lib/types"
import { requireUser, requireWorkspace, type Actor, type Ctx } from "@/server/context"
import { newId } from "@/server/crypto"
import { all, first, nowIso, toMinutes, type MinutesRow } from "@/server/db"
import { findMeeting, VISIBLE, visibleBinds } from "@/server/services/meetings"
import { notify } from "@/server/services/notifications"
import { assertAssignees } from "@/server/services/tasks"
import { translatorFor } from "@/server/translate/providers"
import { detectLang, otherLang, translateText } from "@/server/translate/text"
import { int, isObject, minutesInput, oneOf, str } from "@/server/validate"

const FROM = `meeting_minutes mm LEFT JOIN meetings m ON m.id = mm.meeting_id`

/** Select list for `FROM`; binds: `visibleBinds(actor)` (whether the reader may open the meeting). */
const COLUMNS = `mm.*,
  COALESCE(m.title, mm.meeting_title) AS live_title,
  COALESCE(m.date, mm.meeting_date) AS live_date,
  (SELECT json_group_array(user_id) FROM meeting_minutes_shares WHERE minutes_id = mm.id) AS shared_ids,
  CASE WHEN m.id IS NOT NULL AND ${VISIBLE} THEN 1 ELSE 0 END AS meeting_visible`

/** `canViewMinutes` in SQL (binds: the reader's id, twice). */
const READABLE = `(mm.author_id = ? OR mm.visibility = 'workspace' OR (mm.visibility = 'people' AND EXISTS (SELECT 1 FROM meeting_minutes_shares s WHERE s.minutes_id = mm.id AND s.user_id = ?)))`

async function findMinutes(ctx: Ctx, actor: Actor, id: string): Promise<MeetingMinutes | null> {
  const row = await first<MinutesRow>(
    ctx.db,
    `SELECT ${COLUMNS} FROM ${FROM} WHERE mm.id = ? AND mm.account_id = ?`,
    ...visibleBinds(actor),
    id,
    actor.account.id,
  )
  return row ? toMinutes(row) : null
}

/** Minutes the actor may read, else `minutesNotFound` (existence stays hidden). */
async function findReadable(ctx: Ctx, accountId: string, id: unknown) {
  const actor = await requireWorkspace(ctx, accountId)
  const minutes = await findMinutes(ctx, actor, str(id, 100))
  if (!minutes || !canViewMinutes(actor, minutes)) throw new AppError("minutesNotFound")
  return { actor, minutes }
}

/** A meeting the actor can see (and so write minutes of). */
async function findWritableMeeting(ctx: Ctx, actor: Actor, meetingId: unknown) {
  const meeting = await findMeeting(ctx, actor.account.id, str(meetingId, 100))
  if (!meeting || !canWriteMinutes(actor, meeting)) throw new AppError("meetingNotFound")
  return meeting
}

/** The minutes of one meeting the reader can see: their own first, then others' by last edit. */
export async function listMeetingMinutes(
  ctx: Ctx,
  accountId: string,
  meetingId: unknown,
): Promise<MeetingMinutes[]> {
  const actor = await requireWorkspace(ctx, accountId)
  const meeting = await findWritableMeeting(ctx, actor, meetingId)
  const rows = await all<MinutesRow>(
    ctx.db,
    `SELECT ${COLUMNS} FROM ${FROM}
     WHERE mm.meeting_id = ? AND mm.account_id = ? AND ${READABLE}
     ORDER BY mm.author_id = ? DESC, mm.updated_at DESC`,
    ...visibleBinds(actor),
    meeting.id,
    accountId,
    actor.id,
    actor.id,
    actor.id,
  )
  return rows.map(toMinutes)
}

/** Every set of minutes the reader can see in the workspace, newest meeting first. */
export async function listMinutes(
  ctx: Ctx,
  accountId: string,
  params: unknown,
): Promise<Page<MeetingMinutes>> {
  const actor = await requireWorkspace(ctx, accountId)
  if (!isObject(params)) throw new AppError("badRequest")
  const scope = oneOf(params.scope, MINUTES_SCOPES)
  const search = str(params.search, 200).trim()
  const page = int(params.page, 1, 100_000)
  const pageSize = int(params.pageSize, 1, 100)

  const where = ["mm.account_id = ?"]
  const binds: unknown[] = [accountId]
  if (scope === "mine") {
    where.push("mm.author_id = ?")
    binds.push(actor.id)
  } else {
    where.push(READABLE)
    binds.push(actor.id, actor.id)
    if (scope === "shared") {
      where.push("mm.author_id != ?")
      binds.push(actor.id)
    }
  }
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    where.push(
      `(COALESCE(m.title, mm.meeting_title) LIKE ? ESCAPE '\\' OR mm.body LIKE ? ESCAPE '\\')`,
    )
    binds.push(like, like)
  }
  const whereSql = where.join(" AND ")

  const [rows, count] = await Promise.all([
    all<MinutesRow>(
      ctx.db,
      `SELECT ${COLUMNS} FROM ${FROM} WHERE ${whereSql}
       ORDER BY live_date DESC, mm.updated_at DESC LIMIT ? OFFSET ?`,
      ...visibleBinds(actor),
      ...binds,
      pageSize,
      (page - 1) * pageSize,
    ),
    first<{ total: number }>(
      ctx.db,
      `SELECT COUNT(*) AS total FROM ${FROM} WHERE ${whereSql}`,
      ...binds,
    ),
  ])
  return { items: rows.map(toMinutes), total: count?.total ?? 0 }
}

export async function getMinutes(
  ctx: Ctx,
  accountId: string,
  id: unknown,
): Promise<MeetingMinutes> {
  return (await findReadable(ctx, accountId, id)).minutes
}

/**
 * Check what the author typed. Selected people must be active members (people
 * already on the list may stay); the author is never on their own list.
 */
async function validate(
  ctx: Ctx,
  actor: Actor,
  raw: unknown,
  previousShares: string[] = [],
): Promise<MinutesInput> {
  const input = minutesInput(raw)
  const body = input.body.trim()
  if (!body) throw new AppError("minutesRequired")
  const sharedWithIds =
    input.visibility === "people" ? input.sharedWithIds.filter((id) => id !== actor.id) : []
  if (input.visibility === "people" && sharedWithIds.length === 0) {
    throw new AppError("shareRequired")
  }
  await assertAssignees(ctx, actor.account.id, sharedWithIds, previousShares)
  return { body, visibility: input.visibility, sharedWithIds }
}

function shareStatements(ctx: Ctx, minutesId: string, ids: string[]): D1PreparedStatement[] {
  return [
    ctx.db.prepare("DELETE FROM meeting_minutes_shares WHERE minutes_id = ?").bind(minutesId),
    ctx.db
      .prepare(
        "INSERT INTO meeting_minutes_shares (minutes_id, user_id) SELECT ?, value FROM json_each(?)",
      )
      .bind(minutesId, JSON.stringify(ids)),
  ]
}

/** Write your minutes of a meeting (one set per person per meeting). */
export async function createMinutes(
  ctx: Ctx,
  accountId: string,
  meetingId: unknown,
  raw: unknown,
): Promise<MeetingMinutes> {
  const actor = await requireWorkspace(ctx, accountId)
  const meeting = await findWritableMeeting(ctx, actor, meetingId)
  const input = await validate(ctx, actor, raw)
  const existing = await first(
    ctx.db,
    "SELECT 1 FROM meeting_minutes WHERE meeting_id = ? AND author_id = ?",
    meeting.id,
    actor.id,
  )
  if (existing) throw new AppError("minutesExist")
  const id = newId("mm")
  const now = nowIso()
  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO meeting_minutes (id, account_id, meeting_id, meeting_title, meeting_date,
             author_id, body, visibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          accountId,
          meeting.id,
          meeting.title,
          meeting.date,
          actor.id,
          input.body,
          input.visibility,
          now,
          now,
        ),
      ...shareStatements(ctx, id, input.sharedWithIds),
    ])
  } catch (error) {
    // Saved from another tab in the meantime.
    if (String(error).includes("UNIQUE")) throw new AppError("minutesExist")
    throw error
  }
  const minutes = (await findMinutes(ctx, actor, id))!
  await notifyShared(ctx, actor, minutes, [])
  return minutes
}

/**
 * Change your minutes. `expectedUpdatedAt` is the version the editor opened:
 * a save from another tab in between is reported, not overwritten.
 */
export async function updateMinutes(
  ctx: Ctx,
  accountId: string,
  id: unknown,
  raw: unknown,
  expectedUpdatedAt: unknown,
): Promise<MeetingMinutes> {
  const { actor, minutes } = await findReadable(ctx, accountId, id)
  if (!canEditMinutes(actor, minutes)) throw new AppError("forbidden")
  if (str(expectedUpdatedAt, 40) !== minutes.updatedAt) throw new AppError("minutesChanged")
  const input = await validate(ctx, actor, raw, minutes.sharedWithIds)
  // Keep the meeting's title and date current while it exists.
  const meeting = minutes.meetingId ? await findMeeting(ctx, accountId, minutes.meetingId) : null
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE meeting_minutes SET body = ?, visibility = ?, meeting_title = ?, meeting_date = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.body,
        input.visibility,
        meeting?.title ?? minutes.meetingTitle,
        meeting?.date ?? minutes.meetingDate,
        nowIso(),
        minutes.id,
      ),
    ...shareStatements(ctx, minutes.id, input.sharedWithIds),
  ])
  const next = (await findMinutes(ctx, actor, minutes.id))!
  await notifyShared(ctx, actor, next, minutes.visibility === "people" ? minutes.sharedWithIds : [])
  return next
}

export async function deleteMinutes(ctx: Ctx, accountId: string, id: unknown): Promise<void> {
  const { actor, minutes } = await findReadable(ctx, accountId, id)
  if (!canEditMinutes(actor, minutes)) throw new AppError("forbidden")
  await ctx.db.prepare("DELETE FROM meeting_minutes WHERE id = ?").bind(minutes.id).run()
}

/** Whether a translation service is set up (shows the minutes' Translate button). */
export async function getTranslationAvailable(ctx: Ctx): Promise<boolean> {
  await requireUser(ctx)
  return Boolean(await translatorFor(ctx))
}

/**
 * Minutes in the other language, when a reader asks for it. Never automatic
 * (minutes can be private, and the service is outside the app), and not stored.
 */
export async function translateMinutes(
  ctx: Ctx,
  accountId: string,
  id: unknown,
): Promise<FieldTranslation> {
  const { minutes } = await findReadable(ctx, accountId, id)
  const translator = await translatorFor(ctx)
  if (!translator) throw new AppError("translationNotConfigured")
  const from = detectLang(minutes.body)
  if (!from) throw new AppError("nothingToTranslate")
  const lang = otherLang(from)
  try {
    const text = await translateText(translator, minutes.body, from, lang)
    return { from, lang, text, status: "done" }
  } catch (error) {
    console.error("minutes translation failed", error)
    throw new AppError("translationFailed")
  }
}

/**
 * Tell people newly selected to read the minutes. Sharing with the whole
 * workspace notifies nobody, and later edits don't notify again.
 */
async function notifyShared(
  ctx: Ctx,
  actor: Actor,
  minutes: MeetingMinutes,
  previous: string[],
): Promise<void> {
  if (minutes.visibility !== "people") return
  await notify(ctx, {
    recipients: minutes.sharedWithIds.filter((id) => !previous.includes(id)),
    actorId: actor.id,
    event: "minutes_shared",
    accountId: actor.account.id,
    data: {
      actor: actor.user.name,
      workspace: actor.account.name,
      title: minutes.meetingTitle,
      date: minutes.meetingDate,
    },
    link: `/w/${actor.account.id}/minutes?minutes=${minutes.id}`,
  })
}
