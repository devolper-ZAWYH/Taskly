/**
 * Validation and merge rules for what a recording device pushes, kept free of
 * the database so tests can run them directly. The API contract lives in
 * docs/live-meetings.md; `server/services/live.ts` wires these to storage.
 */
import { AppError } from "@/lib/api/core"
import { LIVE_SESSION_STATUSES, LIVE_SOURCES, type LiveSource } from "@/lib/types"
import { date, int, isObject, oneOf, str } from "@/server/validate"

/** Batch and text caps from the device contract. */
export const MAX_SEGMENTS_PER_PUSH = 200
export const MAX_SEGMENT_TEXT = 4_000
export const MAX_TITLE_LENGTH = 200
export const MAX_NAME_LENGTH = 50
export const MAX_SEQ = 2 ** 31 - 1
/** How far a cursor read walks at once (the panel pulls the rest next poll). */
export const TRANSCRIPT_READ_LIMIT = 500

const bad = (): never => {
  throw new AppError("badRequest")
}

export type PushSegment = {
  seq: number
  source: LiveSource
  lang: string | null
  text: string
  textEn: string | null
  textAr: string | null
  startedAtMs: number | null
  endedAtMs: number | null
}

export type PushInput = {
  session_id: string
  segments: PushSegment[]
}

/** Fields of `POST /api/live/sessions`: a title, a date, optional claimed meeting. */
export type StartInput = {
  meeting_title: string
  meeting_date: string
  meeting_id?: string
}

/** Fields of `POST /api/live/push` exactly as the device sends them. */
export function parsePushInput(value: unknown): PushInput {
  if (!isObject(value)) bad()
  const raw = value as Record<string, unknown>
  // tsconfig paths make `raw.segments` unknown; the runtime check below is
  // what actually refuses non-arrays (bad() throws).
  const segments: unknown[] = Array.isArray(raw.segments) ? raw.segments : bad()
  if (segments.length > MAX_SEGMENTS_PER_PUSH) bad()
  return { session_id: str(raw.session_id, 100), segments: segments.map(parseSegment) }
}

function parseSegment(value: unknown): PushSegment {
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  const startedAtMs = optMs(v.started_at)
  const endedAtMs = optMs(v.ended_at)
  if (startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs) bad()
  return {
    seq: int(v.seq, 1, MAX_SEQ),
    source: oneOf(v.source, LIVE_SOURCES),
    // The device's own language guess ("ar", "en"…); it decides, we only cap.
    lang: v.lang === undefined || v.lang === null ? null : str(v.lang, 20),
    text: str(v.text, MAX_SEGMENT_TEXT),
    textEn: v.text_en === undefined || v.text_en === null ? null : str(v.text_en, MAX_SEGMENT_TEXT),
    // Optional: older engines only send the English line.
    textAr: v.text_ar === undefined || v.text_ar === null ? null : str(v.text_ar, MAX_SEGMENT_TEXT),
    startedAtMs,
    endedAtMs,
  }
}

/** Milliseconds from the session start, or "" when the device left it out. */
function optMs(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null
  return int(value, 0, MAX_SEQ)
}

/** `POST /api/live/sessions`: title (non-empty, ≤200) and `YYYY-MM-DD` date. */
export function parseStartInput(value: unknown): StartInput {
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  const meeting_title = str(v.meeting_title, MAX_TITLE_LENGTH)
  if (!meeting_title.trim()) bad()
  const input: StartInput = { meeting_title, meeting_date: date(v.meeting_date, false) }
  if (v.meeting_id !== undefined && v.meeting_id !== null) {
    input.meeting_id = str(v.meeting_id, 100)
  }
  return input
}

/**
 * One (session, seq) is one row: the same seq twice in a batch keeps the first
 * copy, matching what the UNIQUE constraint keeps of an earlier push.
 */
export function dedupeBatch(segments: PushSegment[]): PushSegment[] {
  const seen = new Set<number>()
  const kept: PushSegment[] = []
  for (const segment of segments) {
    if (seen.has(segment.seq)) continue
    seen.add(segment.seq)
    kept.push(segment)
  }
  return kept
}

/** Cursor read: only what the reader hasn't seen yet. */
export function beyondCursor(segments: PushSegment[], afterSeq: number): PushSegment[] {
  return segments.filter((segment) => segment.seq > afterSeq)
}

/** Where this batch's transcript reaches (0 for an empty batch). */
export function lastSeqOf(segments: PushSegment[]): number {
  return segments.reduce((max, segment) => Math.max(max, segment.seq), 0)
}

/** Rows go in in seq order; `created_at` stamps the landing. */
export function bySeq(
  segments: PushSegment[],
): { ascending: PushSegment[]; descending: PushSegment[] } {
  const ascending = [...segments].sort((a, b) => a.seq - b.seq)
  return { ascending, descending: [...ascending].reverse() }
}

/** Session statuses a push may still write to; anything else reads as ended. */
export function isOpenStatus(status: (typeof LIVE_SESSION_STATUSES)[number]): boolean {
  return status === "capturing"
}
