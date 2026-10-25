#!/usr/bin/env node
/**
 * replay-live — stand-in for the desktop engine's recorder (Phase 1 smoke aid,
 * docs/live-meetings.md). It exercises exactly the endpoints a device uses:
 *
 *   node scripts/replay-live.mjs --token tsk_lv_… [--file transcript.jsonl]
 *        [--url http://localhost:3100] [--dry-run] [--live] [--batch 50]
 *        [--meeting <id>] [--reset]
 *
 *   • starts a session on POST /api/live/sessions (title+date, optional
 *     --meeting claim),
 *   • pushes the lines as POST /api/live/push batches of ≤200 segments, seq
 *     numbers continuing from where the last run stopped — a repeat of an
 *     already-acked seq is ACK'd, never an error,
 *   • ends the session on POST /api/live/sessions/[id]/end,
 *   • --live paces the pushes 3 s apart, following a real meeting;
 *   • --dry-run prints what it would send and touches nothing.
 *
 * Progress (which seq was last acked) is remembered in a state file under the
 * OS temp dir, keyed by URL and token hash (the token itself is never
 * written). A finished run stays finished; use --reset to replay from seq 1.
 * Logs carry ids and counts only — never the lines themselves.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const has = (name) => args.includes(`--${name}`)

const BASE_URL = (flag("url") ?? "http://localhost:3100").replace(/\/$/, "")
const TOKEN = flag("token")
const BATCH = Math.max(1, Math.min(200, Number(flag("batch") ?? 50)))
const LIVE = has("live") // pace at 3 s between pushes, like a real meeting
const DRY_RUN = has("dry-run")
const RESET = has("reset")
const MEETING_ID = flag("meeting")
const FILE = flag("file")
const PACE_MS = 3_000

const usage = () => {
  console.log("Usage: node scripts/replay-live.mjs --token tsk_lv_... [--file lines.jsonl] [--url URL] [--dry-run] [--live] [--batch n] [--meeting id] [--reset]")
  process.exit(1)
}

if (!TOKEN && !DRY_RUN) {
  console.log("The device token (Settings → Live capture → Copy) is required: --token tsk_lv_…")
  usage()
}

// ---- Transcript to send ---------------------------------------------------------------------

const SAMPLE = [
  { source: "mic", lang: "ar", text: "يا جماعة، لنبدأ بمراجعة مهام الأسبوع.", text_en: "Alright everyone, let's start with this week's task review." },
  { source: "system", lang: "en", text: "Sure, I finished the migration and the seed.", text_en: null },
  { source: "mic", lang: "ar", text: "ممتاز. والمتأخر؟", text_en: "Great. And what about the overdue ones?" },
  { source: "system", lang: "en", text: "The seed wrote ten tasks; two are overdue.", text_en: null },
  { source: "mic", lang: "en", text: "Let's move them to next Thursday and close the review.", text_en: null },
]

function loadLines() {
  if (!FILE) return SAMPLE
  const text = readFileSync(FILE, "utf8")
  const lines = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    let row
    try {
      row = JSON.parse(line)
    } catch {
      console.log(`--file line ${index + 1} is not valid JSONL; stopping.`)
      process.exit(1)
    }
    lines.push({
      source: row.source === "system" ? "system" : "mic",
      lang: row.lang ?? null,
      text: row.text ?? "",
      text_en: row.text_en ?? row.textEn ?? null,
    })
  })
  return lines
}

// ---- Idempotent state ------------------------------------------------------------------------

/** Keyed by URL + token hash; the raw token never reaches the state file. */
const stateKey = createHash("sha256")
  .update(`${BASE_URL}\n${TOKEN ?? "dry-run"}`)
  .digest("hex")
  .slice(0, 16)
const STATE_FILE = join(tmpdir(), `replay-live-${stateKey}.json`)

let state = { sessionId: null, lastSeq: 0, done: false }
if (existsSync(STATE_FILE)) {
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8"))
  } catch {
    // fall through with the fresh state
  }
}
if (RESET) state = { sessionId: null, lastSeq: 0, done: false }
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state))

// ---- The device contract ---------------------------------------------------------------------

async function call(path, body, token = TOKEN) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = payload.error ?? `HTTP ${response.status}`
    if (response.status === 401)
      console.log(`Server refused the token (401 ${error}): revoked, or the person was deactivated.`)
    else if (response.status === 403)
      console.log(`Server refused this session (403 ${error}): not yours, or the person is out.`)
    else if (response.status === 429)
      console.log("Server throttled the push (429): wait a few seconds and rerun — it will catch up.")
    else console.log(`Server responded ${response.status}: ${error}`)
    process.exit(1)
  }
  return payload
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- Run ---------------------------------------------------------------------------------------

const lines = loadLines()
console.log(
  `replay-live: ${lines.length} line(s) → ${BASE_URL}` +
    (DRY_RUN ? " (dry run)" : "") +
    (LIVE ? " pacing 3s" : ""),
)
if (lines.length === 0) {
  console.log("Nothing to send.")
  process.exit(0)
}

const today = new Date().toISOString().slice(0, 10)
const title = "Rehearsal (replay-live)"

if (DRY_RUN) {
  const batches = Math.ceil(lines.length / BATCH)
  console.log(
    `Would start 1 session${MEETING_ID ? ` claiming meeting ${MEETING_ID}` : " (ad-hoc)"}, then push ` +
      `${batches} batch(es) of ≤${BATCH} segments each, then end it.`,
  )
  console.log("No requests were made.")
  process.exit(0)
}

if (state.done) {
  console.log(
    `The last run already finished (session ${state.sessionId}, seq up to ${state.lastSeq}). ` +
      "Rerun with --reset to record a fresh session.",
  )
  process.exit(0)
}

let session = state.sessionId
if (session) {
  console.log(`Continuing session ${session} from seq ${state.lastSeq + 1}.`)
} else {
  const started = await call("/api/live/sessions", {
    meeting_title: title,
    meeting_date: today,
    ...(MEETING_ID ? { meeting_id: MEETING_ID } : {}),
  })
  session = started.session?.id
  if (!session) {
    console.log("Server accepted the start but sent no session id; stopping.")
    process.exit(1)
  }
  state.sessionId = session
  saveState()
  console.log(`Started session ${session} (${started.session?.status ?? "capturing"}).`)
}

let batchIndex = 0
for (let offset = 0; offset < lines.length; offset += BATCH) {
  const chunk = lines.slice(offset, offset + BATCH)
  const segments = chunk.map((line, index) => ({
    seq: state.lastSeq + 1 + index,
    source: line.source,
    ...(line.lang ? { lang: line.lang } : {}),
    text: line.text,
    ...(line.text_en ? { text_en: line.text_en } : {}),
  }))
  if (LIVE && batchIndex > 0) await sleep(PACE_MS)
  batchIndex += 1
  const acked = await call("/api/live/push", { session_id: session, segments })
  // The contract ACKs repeats; a rerun that re-sends spent seqs is fine.
  state.lastSeq = Math.max(state.lastSeq, Number(acked.last_seq ?? state.lastSeq))
  saveState()
  console.log(`Batch ${batchIndex}: accepted ${acked.accepted} (last_seq ${acked.last_seq}).`)
}

const ended = await call(`/api/live/sessions/${session}/end`)
state.done = true
saveState()
console.log(`Ended session ${session} — status ${ended.session?.status ?? "ended"}. Done.`)
