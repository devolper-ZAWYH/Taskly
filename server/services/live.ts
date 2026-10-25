/**
 * Live meetings (docs/live-meetings.md): recordings pushed by the desktop
 * engine with a device token, and reads by people. Pushes are idempotent per
 * (session, seq); transcript reads follow the meeting's visibility rules
 * (`server/live/access.ts`); device tokens are per (user, workspace),
 * SHA-256-hashed like session tokens and shown to their owner exactly once.
 */
import { AppError } from "@/lib/api/core"
import { canViewMeeting, canWriteMinutes, type Viewer } from "@/lib/permissions"
import { MINUTES_VISIBILITIES } from "@/lib/types"
import type {
  LiveAcceptResult,
  LiveDraft,
  LiveDraftPayload,
  LiveDeviceToken,
  LiveSegment,
  LiveSession,
  LiveSessionStatus,
  LiveSource,
  LiveTranscript,
  MinutesVisibility,
  Role,
  Task,
} from "@/lib/types"
import { requireUser, requireWorkspace, type Ctx } from "@/server/context"
import { hashToken, newId, newSessionToken } from "@/server/crypto"
import { all, first, nowIso, type AccountRow } from "@/server/db"
import { findMeeting } from "@/server/services/meetings"
import { canReadTranscript } from "@/server/live/access"
import {
  DEVICE_DRAFT_MINUTES,
  MAX_DRAFT_ITEMS,
  parseLiveDraftPayload,
  readLiveDraft,
  restoreLiveDraft,
  saveLiveDraft,
  takeLiveDraft,
} from "@/server/live/drafts"
import {
  assertAcceptVisibility,
  composeMinutesBody,
  parseAcceptItems,
  planActionTask,
} from "@/server/live/review"
import {
  dedupeBatch,
  isOpenStatus,
  lastSeqOf,
  MAX_NAME_LENGTH,
  parsePushInput,
  parseStartInput,
  TRANSCRIPT_READ_LIMIT,
  type PushSegment,
} from "@/server/live/push"
import { matchPerson } from "@/server/mcp/match"
import { createMinutes } from "@/server/services/minutes"
import { assertAssignees, createLiveActionTask } from "@/server/services/tasks"
import {
  MAX_SUMMARY_SEGMENTS,
  parseSummaryDraft,
  summaryPrompt,
  type SummarySegment,
} from "@/server/summarize/prompt"
import { settingsOf } from "@/server/settings"
import { summarizerFor } from "@/server/summarize/providers"
import { ids, int, isObject, oneOf, str } from "@/server/validate"

export type LiveSessionRow = {
  id: string
  account_id: string
  meeting_id: string | null
  meeting_title: string
  meeting_date: string
  user_id: string
  status: LiveSessionStatus
  started_at: string
  ended_at: string | null
  last_seen_at: string | null
  created_at: string
}

export type LiveSegmentRow = {
  id: string
  session_id: string
  seq: number
  source: LiveSource
  lang: string | null
  text: string
  text_en: string | null
  text_ar: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
}

export function toLiveSession(row: LiveSessionRow): LiveSession {
  return {
    id: row.id,
    accountId: row.account_id,
    meetingId: row.meeting_id,
    meetingTitle: row.meeting_title,
    meetingDate: row.meeting_date,
    recorderId: row.user_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastSeenAt: row.last_seen_at,
  }
}

export function toLiveSegment(row: LiveSegmentRow): LiveSegment {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    source: row.source,
    lang: row.lang,
    text: row.text,
    textEn: row.text_en,
    textAr: row.text_ar ?? null,
    startedAtMs: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    endedAtMs: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    createdAt: row.created_at,
  }
}

/** The raw token's prefix keeps it recognisable in logs' absence and in settings. */
const TOKEN_PREFIX = "tsk_lv_"

// ---- Device authentication (routes under /api/live/*) -----------------------

/** What a device token proves: one person, in one workspace. */
export type DeviceAuth = {
  tokenId: string
  userId: string
  accountId: string
  /** The person's role in that workspace (for meeting-claims). */
  role: Role
}

/**
 * `Bearer <raw token>` on the /api/live/* routes. Unknown or malformed tokens
 * are `unauthorized` (401); a revoked token, a deactivated person, or a token
 * whose workspace they left is `forbidden` (403) — the device stops pushing
 * and can ask its settings page for a new token.
 */
export async function authenticateDeviceToken(
  ctx: Ctx,
  request: Request,
): Promise<DeviceAuth> {
  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!token) throw new AppError("unauthorized")
  const row = await first<{
    token_id: string
    account_id: string
    user_id: string
    role: Role | null
    revoked_at: string | null
    active: number
    account_active: number
  }>(
    ctx.db,
    `SELECT t.id AS token_id, t.account_id, t.revoked_at, u.id AS user_id, u.active,
            a.active AS account_active, ms.role
     FROM live_device_tokens t
     JOIN users u ON u.id = t.user_id
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN memberships ms ON ms.account_id = t.account_id AND ms.user_id = u.id
     WHERE t.token_hash = ?`,
    await hashToken(token),
  )
  if (!row) throw new AppError("unauthorized")
  if (row.revoked_at) throw new AppError("forbidden")
  if (row.active !== 1 || row.account_active !== 1) throw new AppError("forbidden")
  // Leaving the workspace revokes the person's tokens there (server/live/
  // tokens.ts); a token from before that change still stops right here.
  if (!row.role) throw new AppError("forbidden")
  const role: Role = row.role
  ctx.waitUntil(
    ctx.db
      .prepare("UPDATE live_device_tokens SET last_used = ? WHERE id = ?")
      .bind(nowIso(), row.token_id)
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  )
  return { tokenId: row.token_id, userId: row.user_id, accountId: row.account_id, role }
}

export const newDeviceToken = (): string => `${TOKEN_PREFIX}${newSessionToken()}`

// ---- Engine endpoints -------------------------------------------------------

/** Badges the pushed batch: how many entries it holds, and where it reaches. */
export type PushResult = { accepted: string; last_seq: number; segments: PushSegment[] }

/** A session the token's device owns, else hidden (unknown or another's). */
async function findOwnSession(
  ctx: Ctx,
  device: DeviceAuth,
  id: string,
): Promise<LiveSessionRow> {
  const row = await first<LiveSessionRow>(
    ctx.db,
    "SELECT * FROM live_sessions WHERE id = ? AND account_id = ?",
    id,
    device.accountId,
  )
  if (!row) throw new AppError("liveSessionNotFound")
  if (row.user_id !== device.userId) throw new AppError("forbidden")
  return row
}

/** `POST /api/live/sessions`: capture starts (with the meeting it claims, if any). */
export async function startLiveSession(ctx: Ctx, device: DeviceAuth, raw: unknown) {
  const input = parseStartInput(raw)
  let meetingId: string | null = null
  let title = input.meeting_title
  let meetingDate = input.meeting_date
  if (input.meeting_id) {
    // The claim wins the meeting's own title and date; members may only
    // claim meetings they take part in, like every meeting read.
    const meeting = await findMeeting(ctx, device.accountId, input.meeting_id)
    if (!meeting || !canViewMeeting({ id: device.userId, role: device.role }, meeting)) {
      throw new AppError("meetingNotFound")
    }
    meetingId = meeting.id
    title = meeting.title
    meetingDate = meeting.date
  }
  const now = nowIso()
  const id = newId("live")
  await ctx.db
    .prepare(
      `INSERT INTO live_sessions (id, account_id, meeting_id, meeting_title, meeting_date,
         user_id, status, started_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'capturing', ?, ?, ?)`,
    )
    .bind(id, device.accountId, meetingId, title, meetingDate, device.userId, now, now, now)
    .run()
  const row = (await first<LiveSessionRow>(
    ctx.db,
    "SELECT * FROM live_sessions WHERE id = ?",
    id,
  ))!
  return toLiveSession(row)
}

/**
 * `POST /api/live/push`: up to 200 segments, idempotent per (session, seq) —
 * repeats are ACK'd, never rewritten, never an error.
 */
export async function pushLiveSegments(ctx: Ctx, device: DeviceAuth, raw: unknown) {
  const input = parsePushInput(raw)
  const session = await findOwnSession(ctx, device, input.session_id)
  if (!isOpenStatus(session.status)) throw new AppError("liveSessionNotFound")
  const segments = dedupeBatch(input.segments)
  // D1 caps bound parameters per query (100); 8 rows × 11 columns fits everywhere.
  const CHUNK_ROWS = 8
  const statements = []
  for (let start = 0; start < segments.length; start += CHUNK_ROWS) {
    const chunk = segments.slice(start, start + CHUNK_ROWS)
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")
    const binds = chunk.flatMap((segment) => [
      newId("lseg"),
      session.id,
      segment.seq,
      segment.source,
      segment.lang,
      segment.text,
      segment.textEn,
      segment.textAr,
      segment.startedAtMs === null ? null : String(segment.startedAtMs),
      segment.endedAtMs === null ? null : String(segment.endedAtMs),
      nowIso(),
    ])
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO live_segments (id, session_id, seq, source, lang, text, text_en, text_ar,
             started_at, ended_at, created_at)
           VALUES ${values}
           ON CONFLICT (session_id, seq) DO NOTHING`,
        )
        .bind(...binds),
    )
  }
  statements.push(
    ctx.db.prepare("UPDATE live_sessions SET last_seen_at = ? WHERE id = ?").bind(nowIso(), session.id),
  )
  // One transaction, on both builds: D1 batches (chat: server/db.ts) and the
  // cPanel SQLite adapter implements the same batch() over BEGIN IMMEDIATE
  // (server/node/d1.ts), which is what minutes.ts already relies on.
  await ctx.db.batch(statements)
  // `accepted` counts every entry of the batch (repeats were stored earlier);
  // `last_seq` is where this batch reaches, derived only from what was sent.
  return {
    accepted: String(input.segments.length),
    last_seq: lastSeqOf(segments),
    segments,
  } satisfies PushResult
}

/** `POST /api/live/sessions/[id]/end`: capture stops; ending again is a no-op. */
export async function endLiveSession(ctx: Ctx, device: DeviceAuth, id: string) {
  const session = await findOwnSession(ctx, device, str(id, 100))
  if (isOpenStatus(session.status)) {
    const now = nowIso()
    await ctx.db
      .prepare("UPDATE live_sessions SET status = 'reviewing', ended_at = ?, last_seen_at = ? WHERE id = ?")
      .bind(now, now, session.id)
      .run()
  }
  const row = (await first<LiveSessionRow>(
    ctx.db,
    "SELECT * FROM live_sessions WHERE id = ?",
    session.id,
  ))!
  return toLiveSession(row)
}

// ---- Cookie-session RPC -----------------------------------------------------

/** The caller's live sessions: recordings they made, newest first. */
export async function liveSessions(ctx: Ctx): Promise<LiveSession[]> {
  await requireUser(ctx)
  const rows = await all<LiveSessionRow>(
    ctx.db,
    "SELECT * FROM live_sessions WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT 200",
    ctx.user!.id,
  )
  return rows.map(toLiveSession)
}

/**
 * The viewer's role in one workspace. Transcripts only exist inside a
 * workspace, so a person who left (no membership row) must not read them
 * there — hidden like everything else in a workspace they don't belong to,
 * even if stale meeting-attendee rows would still satisfy `canViewMeeting`.
 * Operators keep their implicit administrator, as they do for meetings.
 */
async function viewerInAccount(ctx: Ctx, accountId: string): Promise<Viewer> {
  const me = await requireUser(ctx)
  // Operators are administrators everywhere, member row or not (requireWorkspace).
  if (me.isOperator) return { id: me.id, role: "administrator" }
  const row = await first<{ role: Role }>(
    ctx.db,
    `SELECT ms.role FROM accounts a
     JOIN memberships ms ON ms.account_id = a.id AND ms.user_id = ?
     WHERE a.id = ? AND a.active = 1`,
    me.id,
    accountId,
  )
  if (!row) throw new AppError("liveSessionNotFound")
  return { id: me.id, role: row.role }
}

/**
 * Read a transcript past a cursor (the panel polls it every few seconds).
 * The recorder always can; others follow the meeting's own visibility —
 * hidden from people who could never see the meeting, existence included.
 */
export async function liveTranscript(
  ctx: Ctx,
  sessionId: unknown,
  afterSeq: unknown,
): Promise<LiveTranscript> {
  const row = await first<LiveSessionRow>(
    ctx.db,
    "SELECT * FROM live_sessions WHERE id = ?",
    str(sessionId, 100),
  )
  if (!row) throw new AppError("liveSessionNotFound")
  const viewer = await viewerInAccount(ctx, row.account_id)
  const meeting = row.meeting_id ? await findMeeting(ctx, row.account_id, row.meeting_id) : null
  if (!canReadTranscript(viewer, { recorderId: row.user_id }, meeting)) {
    throw new AppError("liveSessionNotFound")
  }
  const cursor = afterSeq == null ? 0 : int(afterSeq, 0, 2 ** 31 - 1)
  const segmentRows = await all<LiveSegmentRow>(
    ctx.db,
    "SELECT * FROM live_segments WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    row.id,
    cursor,
    TRANSCRIPT_READ_LIMIT,
  )
  return { session: toLiveSession(row), segments: segmentRows.map(toLiveSegment) }
}

function toDeviceToken(
  row: { id: string; name: string; account_id: string; workspace: string; last_used: string; created_at: string },
): LiveDeviceToken {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    workspace: row.workspace,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  }
}

/** Settings → Live capture: the devices that can record as this person. */
export async function liveDeviceTokens(ctx: Ctx): Promise<LiveDeviceToken[]> {
  const me = await requireUser(ctx)
  const rows = await all<{
    id: string
    name: string
    account_id: string
    workspace: string
    last_used: string
    created_at: string
  }>(
    ctx.db,
    `SELECT t.id, t.name, t.account_id, a.name AS workspace, t.last_used, t.created_at
     FROM live_device_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = ? AND t.revoked_at IS NULL
     ORDER BY t.created_at DESC, t.id DESC`,
    me.id,
  )
  return rows.map(toDeviceToken)
}

/**
 * Create a device token: raw once (`token`), hash stored. `workspaceId`
 * defaults to the person's only active workspace; with several, Settings
 * picks one. Token-less expiry: nothing expires in v1.
 */
export async function createLiveDeviceToken(
  ctx: Ctx,
  params: unknown,
): Promise<{ token: string; device: LiveDeviceToken }> {
  const me = await requireUser(ctx)
  if (!isObject(params)) throw new AppError("badRequest")
  const input = params as Record<string, unknown>
  const name = str(input.name, MAX_NAME_LENGTH)
  if (!name.trim()) throw new AppError("badRequest")

  let workspaceId = input.workspaceId === undefined || input.workspaceId === null
    ? null
    : str(input.workspaceId, 100)
  if (!workspaceId) {
    const memberships = await all<{ id: string }>(
      ctx.db,
      `SELECT a.id FROM accounts a JOIN memberships ms ON ms.account_id = a.id
       WHERE ms.user_id = ? AND a.active = 1`,
      me.id,
    )
    if (memberships.length !== 1) throw new AppError("badRequest")
    workspaceId = memberships[0].id
  }
  const workspace = await first<AccountRow & { role: Role }>(
    ctx.db,
    `SELECT a.*, ms.role FROM accounts a JOIN memberships ms ON ms.account_id = a.id AND ms.user_id = ?
     WHERE a.id = ? AND a.active = 1`,
    me.id,
    workspaceId,
  )
  // Existence stays hidden, like a read of someone else's workspace.
  // (memberships.role is NOT NULL with a CHECK in 0001_init.sql, so there is no
  // third case to guard.)
  if (!workspace) throw new AppError("workspaceNotFound")

  const raw = newDeviceToken()
  const id = newId("ldt")
  const now = nowIso()
  await ctx.db
    .prepare(
      `INSERT INTO live_device_tokens (id, account_id, user_id, name, token_hash, last_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, workspace.id, me.id, name, await hashToken(raw), now, now)
    .run()
  return {
    token: raw,
    device: toDeviceToken({
      id,
      name,
      account_id: workspace.id,
      workspace: workspace.name,
      last_used: now,
      created_at: now,
    }),
  }
}

/** Revoke one of my devices; unknown, foreign or already revoked: not found. */
export async function deleteLiveDeviceToken(ctx: Ctx, id: unknown): Promise<void> {
  const me = await requireUser(ctx)
  const row = await first<{ id: string }>(
    ctx.db,
    "UPDATE live_device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL RETURNING id",
    nowIso(),
    str(id, 100),
    me.id,
  )
  if (!row) throw new AppError("notFound")
}

// ---- Review: the summary draft and its accept (docs/live-meetings.md §6) ----

/** A draft as the card reads it (payload + its handle and expiry). */
export function draftOf(
  record: { id: string; expiresAt: string },
  sessionId: string,
  payload: LiveDraftPayload,
): LiveDraft {
  return { id: record.id, sessionId, expiresAt: record.expiresAt, ...payload }
}

/** The session the caller recorded and may review — anyone else's stays hidden. */
async function reviewerSession(ctx: Ctx, sessionId: unknown): Promise<LiveSessionRow> {
  const me = await requireUser(ctx)
  const row = await first<LiveSessionRow>(
    ctx.db,
    "SELECT * FROM live_sessions WHERE id = ?",
    str(sessionId, 100),
  )
  // Ownership and existence share one answer: the review of one person's
  // recording is not even a list anyone can guess through.
  if (!row || row.user_id !== me.id) throw new AppError("liveSessionNotFound")
  return row
}

/** `{ sessionId }` as the card sends it (liveDraft, liveDiscard, postLiveDraft). */
function sessionIdParam(params: unknown): string {
  if (!isObject(params)) throw new AppError("badRequest")
  return str((params as Record<string, unknown>).sessionId, 100)
}

const toSummarySegment = (row: LiveSegmentRow): SummarySegment => ({
  source: row.source,
  lang: row.lang,
  text: row.text,
  textEn: row.text_en,
})

/**
 * `POST /api/live/sessions/[id]/draft`: the desktop engine posts the summary it
 * made with its own model (the `on_device` path). Only a session that ended
 * and isn't reviewed yet takes one; wording is validated and re-capped by
 * `parseLiveDraftPayload`, never trusted as sent.
 */
export async function postLiveDraft(ctx: Ctx, device: DeviceAuth, id: string, raw: unknown) {
  const session = await findOwnSession(ctx, device, str(id, 100))
  if (session.status !== "reviewing") throw new AppError("liveSessionNotFound")
  const payload = parseLiveDraftPayload(raw)
  const record = await saveLiveDraft(ctx, {
    userId: device.userId,
    accountId: device.accountId,
    sessionId: session.id,
    payload,
    // Only the device can make it again: it waits for the review.
    lifetimeMinutes: DEVICE_DRAFT_MINUTES,
  })
  return { draft: draftOf(record, session.id, payload) }
}

/**
 * summarize the transcript into a review draft. The recorder only. With a
 * provider set up (Platform → Settings → Summaries), the server does the work
 * and saves one draft per session; otherwise (`on_device`) the engine's
 * already-posted draft is returned — when there is none yet, the device
 * hasn't sent it (`summaryOnDevice`), and with an incomplete service the
 * settings need attention (`summarizerUnavailable`).
 */
export async function liveSummarize(ctx: Ctx, sessionId: unknown): Promise<{ draft: LiveDraft }> {
  const row = await reviewerSession(ctx, sessionId)
  const actor = await requireWorkspace(ctx, row.account_id)
  if (row.status !== "reviewing") throw new AppError("liveSessionNotFound")
  const segmentRows = await all<LiveSegmentRow>(
    ctx.db,
    "SELECT * FROM live_segments WHERE session_id = ? ORDER BY seq LIMIT ?",
    row.id,
    MAX_SUMMARY_SEGMENTS,
  )
  const summarizer = await summarizerFor(ctx)
  if (!summarizer || segmentRows.length === 0) {
    // Summaries stay on the device (or nothing was recorded): the engine's own
    // draft, if it posted one, is the answer.
    const existing = await readLiveDraft(ctx, row.id)
    if (existing) return { draft: existing }
    if (segmentRows.length === 0) throw new AppError("summarizeFailed")
    const { values } = await settingsOf(ctx)
    throw new AppError(
      (values.live_summary_provider || "on_device") === "on_device"
        ? "summaryOnDevice"
        : "summarizerUnavailable",
    )
  }
  let payload: LiveDraftPayload
  try {
    // The prompt itself carries the transcript; the reply is parsed past the
    // wrapper junk (fences, thinking blocks), or never reaches a table.
    const prompt = summaryPrompt(segmentRows.map(toSummarySegment))
    // Then the stored draft's own check: what is saved must read back.
    payload = parseLiveDraftPayload(
      parseSummaryDraft(await summarizer.complete(prompt.system, prompt.user)),
    )
  } catch {
    // Deliberately unspecific: the error text may echo what the reviewer said.
    console.error(`live summarize failed (${summarizer.name})`, { sessionId: row.id })
    throw new AppError("summarizeFailed")
  }
  const record = await saveLiveDraft(ctx, {
    userId: actor.id,
    accountId: row.account_id,
    sessionId: row.id,
    payload,
  })
  return { draft: draftOf(record, row.id, payload) }
}

/** The session's current draft (poll read by the review card), or null. */
export async function liveDraft(
  ctx: Ctx,
  params: unknown,
): Promise<LiveDraft | null> {
  const sessionId = sessionIdParam(params)
  const row = await reviewerSession(ctx, sessionId)
  await requireWorkspace(ctx, row.account_id)
  const found = await readLiveDraft(ctx, row.id)
  return found ? draftOf(found, row.id, found) : null
}

/**
 * Accept: the draft becomes minutes (their own set for the meeting, with the
 * chosen visibility) and action-item tasks linked to the meeting. The rules
 * of server/live/review.ts decide assignees — a name that fits nobody, fits
 * twice, or names someone the member can't appoint leaves the task
 * unassigned with the name in its description (a member's own private task);
 * nothing is ever guessed. Every rule runs against the draft the reviewer saw
 * (`draftId`; a regenerate in between is `liveDraftGone`) before it is
 * consumed, so a refusal never spends it, and a failure writing the minutes
 * gives it back.
 */
export async function liveAccept(ctx: Ctx, params: unknown): Promise<LiveAcceptResult> {
  if (!isObject(params)) throw new AppError("badRequest")
  const v = params as Record<string, unknown>
  const visibility = oneOf(v.visibility, MINUTES_VISIBILITIES) as MinutesVisibility
  const sessionId = str(v.sessionId, 100)
  const draftId = v.draftId === undefined || v.draftId === null ? null : str(v.draftId, 100)
  const note = v.note === undefined || v.note === null ? "" : str(v.note, 2000).trim()
  const overrides = parseAcceptItems(v.items, MAX_DRAFT_ITEMS)

  const row = await reviewerSession(ctx, sessionId)
  // The review happens in the session's workspace: gone or inactive for the
  // recorder means nothing can be written there.
  const actor = await requireWorkspace(ctx, row.account_id)
  // Reviews refuse ad-hoc sessions: minutes belong to the meeting they were
  // captured for.
  if (!row.meeting_id) throw new AppError("liveSessionNotFound")

  // ---- The rule pass: refuses before touching the draft ---------------------
  // Who may read what the engine wrote (stricter than hand-typed minutes).
  assertAcceptVisibility(actor.role, visibility)
  // The meeting must still be the one that keeps the minutes.
  const meeting = await findMeeting(ctx, row.account_id, row.meeting_id)
  if (!meeting || !canWriteMinutes(actor, meeting)) throw new AppError("meetingNotFound")
  // Their own set already exists (hand-written, or a first accept): no
  // second one can be made for the same meeting.
  const existing = await first(
    ctx.db,
    "SELECT 1 FROM meeting_minutes WHERE meeting_id = ? AND author_id = ?",
    meeting.id,
    actor.id,
  )
  if (existing) throw new AppError("minutesExist")
  // Shares must be active members, and the author is never on their own list;
  // reject before the consume, because createMinutes would only object to the
  // same things once the draft is spent.
  const sharedWithIds =
    visibility === "people" ? ids(v.sharedWithIds).filter((id) => id !== actor.id) : []
  if (visibility === "people" && sharedWithIds.length === 0) throw new AppError("shareRequired")
  await assertAssignees(ctx, row.account_id, sharedWithIds)
  // The workspace's people the names are matched against (server/mcp/match.ts):
  // the same rows the assignee check admits — active members only.
  const members = await all<{ id: string; name: string; email: string }>(
    ctx.db,
    `SELECT u.id, u.name, u.email FROM users u
     JOIN memberships ms ON ms.user_id = u.id AND ms.account_id = ?
     WHERE u.active = 1 ORDER BY u.name`,
    row.account_id,
  )

  // The draft the reviewer saw, read without spending it: everything below is
  // checked against exactly this payload.
  const draft = await readLiveDraft(ctx, row.id)
  if (!draft || (draftId !== null && draft.id !== draftId)) throw new AppError("liveDraftGone")
  const body = composeMinutesBody(draft, actor.user.locale, note)
  // A draft with no words at all (and no note to add) can't become minutes.
  if (!body) throw new AppError("minutesRequired")
  const plans = draft.actionItems.map(
    (item, index) =>
      planActionTask({
        actorId: actor.id,
        actorRole: actor.role,
        item,
        override: overrides[index],
        resolved: item.assignee ? matchPerson(item.assignee, members) : null,
        meetingId: meeting.id,
      }).input,
  )
  // The card's picks are ids from the people list it loaded; whoever was
  // deactivated since (or an id that was never a member) refuses here, not
  // half way through writing the tasks.
  await assertAssignees(ctx, row.account_id, [...new Set(plans.flatMap((plan) => plan.assigneeIds))])

  // ---- Consume --------------------------------------------------------------
  const taken = await takeLiveDraft(ctx, {
    id: draft.id,
    sessionId: row.id,
    userId: actor.id,
    accountId: row.account_id,
  })
  if (!taken) throw new AppError("liveDraftGone")

  let minutes: LiveAcceptResult["minutes"]
  try {
    minutes = await createMinutes(ctx, row.account_id, meeting.id, { body, visibility, sharedWithIds })
  } catch (error) {
    // Nothing was written yet (e.g. minutes typed by hand a moment ago):
    // the draft goes back, so the review can still be finished or discarded.
    await restoreLiveDraft(ctx, {
      id: draft.id,
      userId: actor.id,
      accountId: row.account_id,
      sessionId: row.id,
      payload: taken,
      expiresAt: draft.expiresAt,
    })
    throw error
  }

  const tasks: Task[] = []
  for (const input of plans) tasks.push(await createLiveActionTask(ctx, actor, input))

  await ctx.db
    .prepare("UPDATE live_sessions SET status = 'done' WHERE id = ? AND status = 'reviewing'")
    .bind(row.id)
    .run()
  return { minutes, tasks }
}

/**
 * Discard: the draft is dropped unconsumed and the session ends its review.
 * The card already rendered what it showed, so nothing is written anywhere —
 * discarding twice (or after an accept) is a quiet no-op on the same session.
 */
export async function liveDiscard(ctx: Ctx, params: unknown): Promise<LiveSession> {
  const sessionId = sessionIdParam(params)
  const row = await reviewerSession(ctx, sessionId)
  await requireWorkspace(ctx, row.account_id)
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM live_drafts WHERE session_id = ?").bind(row.id),
    ctx.db
      .prepare("UPDATE live_sessions SET status = 'done' WHERE id = ? AND status = 'reviewing'")
      .bind(row.id),
  ])
  const next = (await first<LiveSessionRow>(
    ctx.db,
    "SELECT * FROM live_sessions WHERE id = ?",
    row.id,
  ))!
  return toLiveSession(next)
}

