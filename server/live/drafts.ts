/**
 * Drafts of a live session's review (summary, decisions, action items,
 * follow-ups), held for 15 minutes under a random handle — mirrored from
 * `server/mcp/drafts.ts` so the review card shows what was checked and writes
 * with one call. The summarizer writes exactly one live draft per session:
 * saving replaces the previous one (a regenerate never leaves two), and the
 * accept takes it out — a draft is consumed by the delete that returns it.
 */
import type { LiveDraftActionItem, LiveDraftPayload } from "@/lib/types"
import { AppError } from "@/lib/api/core"
import type { Ctx } from "@/server/context"
import { first, nowIso } from "@/server/db"
import { newId } from "@/server/crypto"
import { date, isObject, str } from "@/server/validate"

const DRAFT_MINUTES = 15
/**
 * A draft the recording device posted lives much longer: the server can't
 * make it again (Summarize just returns it), and the review usually happens
 * later than the quarter hour after the meeting.
 */
export const DEVICE_DRAFT_MINUTES = 7 * 24 * 60

// The engine contract's caps (docs/live-meetings.md §5): re-declared here so
// both the route and the provider path validate the same numbers.
export const MAX_DRAFT_SUMMARY = 20_000
export const MAX_DRAFT_SECTION_ITEMS = 25
export const MAX_DRAFT_SECTION_LINE = 500
export const MAX_DRAFT_ITEMS = 30
export const MAX_DRAFT_TITLE = 200
export const MAX_DRAFT_ASSIGNEE = 100

export type { LiveDraftActionItem, LiveDraftPayload }

function bad(): never {
  throw new AppError("badRequest")
}

const list = (value: unknown, max: number, cap: number): string[] => {
  if (!Array.isArray(value)) bad()
  if (value.length > cap) bad()
  return value.map((item) => {
    const line = str(item, max)
    if (!line.trim()) bad()
    return line.trim()
  })
}

/**
 * The fixed sections of docs/live-meetings.md §5; never trusted as sent. Reads
 * the wire's snake_case (`action_items`, `follow_ups`) — and the same two keys
 * camelCase, because the stored JSON is the validated shape and round-trips
 * through this parser when the review claims it. Everything is re-capped:
 * storage never extends what the validation allowed.
 */
export function parseLiveDraftPayload(value: unknown): LiveDraftPayload {
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  const sections = v.sections
  if (!isObject(sections)) bad()
  const s = sections as Record<string, unknown>
  const summary = str(s.summary, MAX_DRAFT_SUMMARY)
  const decisions = list(s.decisions ?? [], MAX_DRAFT_SECTION_LINE, MAX_DRAFT_SECTION_ITEMS)
  const followUps = list(s.follow_ups ?? s.followUps ?? [], MAX_DRAFT_SECTION_LINE, MAX_DRAFT_SECTION_ITEMS)

  const items = v.action_items ?? v.actionItems
  if (!Array.isArray(items)) bad()
  if (items.length > MAX_DRAFT_ITEMS) bad()
  const actionItems = items.map((item): LiveDraftActionItem => {
    if (!isObject(item)) bad()
    const one = item as Record<string, unknown>
    const title = str(one.title, MAX_DRAFT_TITLE)
    if (!title.trim()) bad()
    const draft: LiveDraftActionItem = { title: title.trim() }
    if (one.assignee !== undefined && one.assignee !== null && one.assignee !== "") {
      const assignee = str(one.assignee, MAX_DRAFT_ASSIGNEE).trim()
      if (assignee) draft.assignee = assignee
    }
    if (one.due !== undefined && one.due !== null && one.due !== "") {
      draft.due = date(one.due, false)
    }
    return draft
  })
  return { sections: { summary, decisions, followUps }, actionItems }
}

/** When a draft of this payload stops being trustworthy. */
export function draftExpiry(from: number, minutes = DRAFT_MINUTES): string {
  return new Date(from + minutes * 60_000).toISOString()
}

/** Expired? (Compared with ISO times, as every column stores them.) */
export function isDraftExpired(expiresAt: string, now: string): boolean {
  return expiresAt < now
}

/** A saved draft, shaped as the review card reads it. */
export type LiveDraftRecord = { id: string; expiresAt: string }

/**
 * Save a draft as the session's ONLY unconsumed one: this person's expired
 * drafts are swept lazily and the session's previous draft is deleted in the
 * same transaction (a regenerate can't leave two claims around).
 */
export async function saveLiveDraft(
  ctx: Ctx,
  draft: {
    userId: string
    accountId: string
    sessionId: string
    payload: LiveDraftPayload
    /** How long it stays claimable (15 minutes unless the device posted it). */
    lifetimeMinutes?: number
  },
): Promise<LiveDraftRecord> {
  const id = newId("ldraft")
  const now = nowIso()
  const expiresAt = draftExpiry(Date.now(), draft.lifetimeMinutes)
  await ctx.db.batch([
    // Housekeeping: this person's expired drafts, and any earlier draft of
    // this session (single-use rows; their data was never consumed but is dead).
    ctx.db
      .prepare("DELETE FROM live_drafts WHERE user_id = ? AND expires_at < ?")
      .bind(draft.userId, now),
    ctx.db.prepare("DELETE FROM live_drafts WHERE session_id = ?").bind(draft.sessionId),
    ctx.db
      .prepare(
        `INSERT INTO live_drafts (id, account_id, user_id, session_id, payload, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        draft.accountId,
        draft.userId,
        draft.sessionId,
        JSON.stringify(draft.payload),
        expiresAt,
        now,
      ),
  ])
  return { id, expiresAt }
}

/**
 * Take a draft out (single use). One DELETE…RETURNING is the whole mechanism —
 * the row is gone the moment it's read, so a second accept (or a card and a
 * client racing) gets null, like `takeDraft` in server/mcp/drafts.ts. Null
 * unless it is exactly the draft the reviewer saw (`id`: a regenerate in
 * between is a different draft), belongs to this person and workspace, and
 * hasn't expired.
 */
export async function takeLiveDraft(
  ctx: Ctx,
  draft: { id: string; sessionId: string; userId: string; accountId: string },
): Promise<LiveDraftPayload | null> {
  const row = await first<{ payload: string; expires_at: string }>(
    ctx.db,
    `DELETE FROM live_drafts WHERE id = ? AND session_id = ? AND user_id = ? AND account_id = ?
     RETURNING payload, expires_at`,
    draft.id,
    draft.sessionId,
    draft.userId,
    draft.accountId,
  )
  if (!row || isDraftExpired(row.expires_at, nowIso())) return null
  try {
    return parseLiveDraftPayload(JSON.parse(row.payload))
  } catch {
    // Unreadable stored payload: no draft, as `readLiveDraft` answers.
    return null
  }
}

/**
 * Put a taken draft back when the write it was taken for failed before
 * anything was written — unless the session already has a newer draft (the
 * engine re-posted meanwhile), which then stays the only one.
 */
export async function restoreLiveDraft(
  ctx: Ctx,
  draft: {
    id: string
    userId: string
    accountId: string
    sessionId: string
    payload: LiveDraftPayload
    expiresAt: string
  },
): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO live_drafts (id, account_id, user_id, session_id, payload, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM live_drafts WHERE session_id = ?)`,
    )
    .bind(
      draft.id,
      draft.accountId,
      draft.userId,
      draft.sessionId,
      JSON.stringify(draft.payload),
      draft.expiresAt,
      nowIso(),
      draft.sessionId,
    )
    .run()
}

/** The session's live draft, or null when there isn't one (or it expired). */
export async function readLiveDraft(
  ctx: Ctx,
  sessionId: string,
): Promise<
  (LiveDraftPayload & { id: string; sessionId: string; expiresAt: string }) | null
> {
  const row = await first<{ id: string; payload: string; expires_at: string }>(
    ctx.db,
    `SELECT id, payload, expires_at FROM live_drafts
     WHERE session_id = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    sessionId,
    nowIso(),
  )
  if (!row) return null
  try {
    const payload = parseLiveDraftPayload(JSON.parse(row.payload))
    return { ...payload, id: row.id, sessionId, expiresAt: row.expires_at }
  } catch {
    // An unreadable stored payload is no draft at all (the card stays empty).
    return null
  }
}

/** Drop the session's draft without consuming it (Discard). */
export async function deleteLiveDraftForSession(ctx: Ctx, sessionId: string): Promise<void> {
  await ctx.db.prepare("DELETE FROM live_drafts WHERE session_id = ?").bind(sessionId).run()
}

/** Kept for the corpus of optional fields the retention sweep might read. */
export const LIVE_DRAFT_MINUTES = DRAFT_MINUTES
