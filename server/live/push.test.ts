/**
 * The device contract's rules (docs/live-meetings.md): what a push validates,
 * how repeated seqs and cursors merge, and what a session start carries.
 * Pure checks — the storage wiring (`server/services/live.ts`) keeps its own
 * smoke verified against the local database.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { AppError } from "@/lib/api/core"
import type { LiveSource } from "@/lib/types"
import {
  MAX_SEGMENTS_PER_PUSH,
  MAX_SEGMENT_TEXT,
  MAX_SEQ,
  beyondCursor,
  bySeq,
  dedupeBatch,
  isOpenStatus,
  lastSeqOf,
  parsePushInput,
  parseStartInput,
  type PushSegment,
} from "./push.ts"

const bad = (run: () => unknown): void => {
  assert.throws(run, (error: unknown) => error instanceof AppError && error.code === "badRequest")
}

const segment = (seq: number, overrides: Partial<PushSegment> = {}): PushSegment => ({
  seq,
  source: "mic",
  lang: "ar",
  text: `سطر ${seq}`,
  textEn: `line ${seq}`,
  textAr: null,
  startedAtMs: seq * 1_000,
  endedAtMs: seq * 1_000 + 900,
  ...overrides,
})

/** A valid full push body; tests specialize it with wire field names. */
const pushBody = (overrides: Record<string, unknown> = {}, one: Record<string, unknown> = {}) => ({
  session_id: "live-session-1",
  segments: [{ ...segment(1), ...one }],
  ...overrides,
})

// ---- What a push accepts ---------------------------------------------------------------------

test("a well-formed push parses: snake-case body to typed segments", () => {
  const input = parsePushInput({
    session_id: "live-session-1",
    segments: [
      {
        seq: 7,
        source: "system",
        lang: null,
        text: "سطر سبعة",
        text_en: null,
        text_ar: "سطر سبعة",
        started_at: null,
        ended_at: null,
      },
    ],
  })
  assert.deepEqual(input.segments, [
    {
      seq: 7,
      source: "system",
      lang: null,
      text: "سطر سبعة",
      textEn: null,
      textAr: "سطر سبعة",
      startedAtMs: null,
      endedAtMs: null,
    },
  ])
})

test("an empty batch is a valid heartbeat (accepted, last_seq 0)", () => {
  const input = parsePushInput({ session_id: "s", segments: [] })
  assert.deepEqual(input.segments, [])
  assert.equal(lastSeqOf(input.segments), 0)
})

test("a push without a session_id, segments array, or oversized batch is rejected", () => {
  bad(() => parsePushInput({ segments: [segment(1)] }))
  bad(() =>
    parsePushInput({
      session_id: "s",
      segments: Array.from({ length: MAX_SEGMENTS_PER_PUSH + 1 }, (_, i) => segment(i + 1)),
    }),
  )
  bad(() => parsePushInput({ session_id: "s" }))
  bad(() => parsePushInput("nope"))
  bad(() => parsePushInput(pushBody({ session_id: "x".repeat(101) })))
})

test("text_ar is optional: absent or null parses to null", () => {
  assert.equal(parsePushInput(pushBody()).segments[0].textAr, null)
  assert.equal(parsePushInput(pushBody({}, { text_ar: null })).segments[0].textAr, null)
  assert.equal(parsePushInput(pushBody({}, { text_ar: "مرحبا" })).segments[0].textAr, "مرحبا")
})

test("segment fields validate: source, seq, text, timestamps, text_en, text_ar, lang", () => {
  bad(() => parsePushInput(pushBody({}, { source: "headset" as unknown as LiveSource })))
  bad(() => parsePushInput(pushBody({}, { seq: 0 })))
  bad(() => parsePushInput(pushBody({}, { seq: MAX_SEQ + 1 })))
  bad(() => parsePushInput(pushBody({}, { seq: 1.5 })))
  bad(() => parsePushInput(pushBody({}, { text: "x".repeat(MAX_SEGMENT_TEXT + 1) })))
  bad(() => parsePushInput(pushBody({}, { text_en: "x".repeat(MAX_SEGMENT_TEXT + 1) })))
  bad(() => parsePushInput(pushBody({}, { text_ar: "x".repeat(MAX_SEGMENT_TEXT + 1) })))
  bad(() => parsePushInput(pushBody({}, { text_ar: 7 })))
  bad(() => parsePushInput(pushBody({}, { lang: "x".repeat(21) })))
  // ended before it began: a clock that runs backwards is a device bug.
  bad(() => parsePushInput(pushBody({}, { started_at: 900, ended_at: 800 })))
  bad(() => parsePushInput(pushBody({}, { started_at: -1 })))
  bad(() => parsePushInput(pushBody({}, { ended_at: -1 })))
})

// ---- What a session start accepts -------------------------------------------------------------

test("a session start parses a title, date and optional claim", () => {
  assert.deepEqual(
    parseStartInput({ meeting_title: "اتجاهات الربع", meeting_date: "2026-10-22" }),
    {
      meeting_title: "اتجاهات الربع",
      meeting_date: "2026-10-22",
    },
  )
  assert.deepEqual(
    parseStartInput({
      meeting_title: "Standup",
      meeting_date: "2026-10-22",
      meeting_id: "meeting-1",
    }),
    { meeting_title: "Standup", meeting_date: "2026-10-22", meeting_id: "meeting-1" },
  )
})

test("a session start needs a real title and a full-date", () => {
  bad(() => parseStartInput({ meeting_title: "   ", meeting_date: "2026-10-22" }))
  bad(() => parseStartInput({ meeting_title: "", meeting_date: "2026-10-22" }))
  bad(() => parseStartInput({ meeting_title: "Standup", meeting_date: "2026-10" }))
  bad(() => parseStartInput({ meeting_title: "Standup", meeting_date: "  " }))
  bad(() => parseStartInput({ meeting_title: "Standup" }))
  bad(() => parseStartInput("nope"))
  bad(() => parseStartInput({ meeting_title: "x".repeat(201), meeting_date: "2026-10-22" }))
})

// ---- Merge rules ------------------------------------------------------------------------------

test("the same seq twice in one batch keeps the first copy (as the UNIQUE constraint would)", () => {
  const kept = dedupeBatch([
    segment(1, { text: "first" }),
    segment(1, { text: "resend" }),
    segment(2),
  ])
  assert.deepEqual(kept, [segment(1, { text: "first" }), segment(2)])
  assert.deepEqual(dedupeBatch([]), [])
})

test("last_seq is the highest seq in the batch, 0 when empty", () => {
  assert.equal(lastSeqOf([segment(3), segment(9), segment(5)]), 9)
  assert.equal(lastSeqOf([]), 0)
})

test("a cursor read only returns beyond it", () => {
  const batch = [segment(5), segment(6), segment(7)]
  assert.deepEqual(beyondCursor(batch, 6), [segment(7)])
  assert.deepEqual(beyondCursor(batch, 7), [])
  assert.deepEqual(beyondCursor(batch, 0), batch)
})

test("rows sort asc for reads and desc for the stored merge order", () => {
  const sorted = bySeq([segment(3), segment(1), segment(2)])
  assert.deepEqual(
    sorted.ascending.map((one) => one.seq),
    [1, 2, 3],
  )
  assert.deepEqual(
    sorted.descending.map((one) => one.seq),
    [3, 2, 1],
  )
})

test("only a capturing session accepts pushes", () => {
  assert.equal(isOpenStatus("capturing"), true)
  assert.equal(isOpenStatus("reviewing"), false)
  assert.equal(isOpenStatus("done"), false)
  assert.equal(isOpenStatus("aborted"), false)
})
