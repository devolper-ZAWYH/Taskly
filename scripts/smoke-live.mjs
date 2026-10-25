#!/usr/bin/env node
/**
 * smoke-live — checks the device endpoints' contract against a running Taskly
 * (docs/live-meetings.md §3). With --foreign-token it also proves whose
 * session is whose (403). Uses the demo person for the cookie reads.
 *
 *   node scripts/smoke-live.mjs --token tsk_lv_… [--foreign-token tsk_lv_…] [--url …]
 *
 * Exits non-zero on the first wrong answer.
 */
import assert from "node:assert/strict"

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const BASE = (flag("url") ?? "http://localhost:3100").replace(/\/$/, "")
const TOKEN = flag("token")
const FOREIGN = flag("foreign-token")

const call = async (path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) ?? {} }
}

const seg = (seq) => ({
  seq,
  source: seq % 2 ? "mic" : "system",
  lang: "ar",
  text: `سطر ${seq}`,
  text_en: `line ${seq}`,
  // Optional: odd seqs leave it out, as older engines do.
  ...(seq % 2 ? {} : { text_ar: `سطر ${seq} بالعربية` }),
  started_at: seq * 1_000,
  ended_at: seq * 1_000 + 800,
})
const push = (token, sessionId, segments) =>
  call("/api/live/push", { session_id: sessionId, segments }, token)

// ---- Start --------------------------------------------------------------------------------

const started = await call("/api/live/sessions", {
  meeting_title: "Smoke contract",
  meeting_date: new Date().toISOString().slice(0, 10),
}, TOKEN)
assert.equal(started.status, 200, `start: ${JSON.stringify(started.body)}`)
const sessionId = started.body.session?.id
assert.ok(sessionId, "no session id in start reply")
console.log(`✔ start → ${sessionId} (${started.body.session?.status})`)

// ---- Pushes -------------------------------------------------------------------------------

let reply = await push(TOKEN, sessionId, [seg(1), seg(2)])
assert.deepEqual(reply.body, { accepted: "2", last_seq: 2 }, `first push: ${JSON.stringify(reply)}`)
console.log("✔ push 2 segments →", reply.body)

reply = await push(TOKEN, sessionId, [seg(1), seg(2)])
assert.deepEqual(reply.body, { accepted: "2", last_seq: 2 }, `repeats: ${JSON.stringify(reply)}`)
console.log("✔ same seqs again → ACK'd, not an error:", reply.body)

reply = await push(TOKEN, sessionId, [])
assert.deepEqual(reply.body, { accepted: "0", last_seq: 0 }, `empty: ${JSON.stringify(reply)}`)
console.log("✔ empty batch (heartbeat) →", reply.body)

// ---- Statuses -----------------------------------------------------------------------------

let bad = await push(TOKEN, "live-unknown", [seg(1)])
assert.equal(bad.status, 404, `unknown session: ${JSON.stringify(bad)}`)
assert.ok(bad.body.error === "liveSessionNotFound" || bad.body.error === "notFound")
console.log("✔ unknown session →", bad.status, bad.body)

bad = await push(TOKEN, sessionId, [{ seq: 0, source: "mic", text: "x" }])
assert.equal(bad.status, 400, `malformed: ${JSON.stringify(bad)}`)
assert.equal(bad.body.error, "badRequest")
console.log("✔ seq 0 →", bad.status, bad.body)

reply = await push(TOKEN, sessionId, [seg(3)])
assert.equal(reply.status, 200, `owner continuation: ${JSON.stringify(reply)}`)
console.log("✔ owner's continuation →", reply.status, reply.body)

if (FOREIGN) {
  const foreign = await push(FOREIGN, sessionId, [seg(99)])
  assert.equal(foreign.status, 403, `foreign session: ${JSON.stringify(foreign)}`)
  assert.equal(foreign.body.error, "forbidden")
  console.log("✔ another person's token on this session →", foreign.status, foreign.body)
}

bad = await push(undefined, sessionId, [seg(3)])
assert.equal(bad.status, 401, `missing token: ${JSON.stringify(bad)}`)
assert.equal(bad.body.error, "unauthorized")
console.log("✔ no Authorization →", bad.status, bad.body)

bad = await push("tsk_lv_MM", sessionId, [seg(3)])
assert.equal(bad.status, 401, `wrong token: ${JSON.stringify(bad)}`)
console.log("✔ wrong token →", bad.status, bad.body)

// ---- End (twice) ----------------------------------------------------------------------------

let ended = await call(`/api/live/sessions/${sessionId}/end`, {}, TOKEN)
assert.equal(ended.status, 200, `end: ${JSON.stringify(ended.body)}`)
assert.equal(ended.body.session?.status, "reviewing")
console.log("✔ end → status reviewing")

ended = await call(`/api/live/sessions/${sessionId}/end`, {}, TOKEN)
assert.equal(ended.status, 200, `re-end: ${JSON.stringify(ended.body)}`)
assert.equal(ended.body.session?.status, "reviewing")
console.log("✔ end again → no-op, still reviewing")

bad = await push(TOKEN, sessionId, [seg(3)])
assert.equal(bad.status, 404, `push after end: ${JSON.stringify(bad)}`)
console.log("✔ push to ended session →", bad.status, bad.body)

// ---- Cookie reads (the person's own views) ---------------------------------------------------

const login = await fetch(`${BASE}/api/rpc/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ args: ["admin@example.com", "admin1234"] }),
})
assert.ok(login.status === 200, `login: ${login.status} ${await login.text()}`)
const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
console.log("✔ cookie login →", login.status)

const rpc = async (method, RID) => {
  const response = await fetch(`${BASE}/api/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: RID ?? [] }),
  })
  return { status: response.status, body: (await response.json())?.data }
}

// The recorder finds their sessions and reads their own transcript.
const sessions = await rpc("liveSessions", [])
assert.equal(sessions.status, 200)
assert.ok(sessions.body.some((one) => one.id === sessionId), "smoke session missing from liveSessions")
console.log("✔ liveSessions →", sessions.status, `${sessions.body.length} session(s)`)

const transcript = await rpc("liveTranscript", [sessionId, 0])
assert.equal(transcript.status, 200)
assert.ok(transcript.body.segments.length >= 3, `transcript: ${JSON.stringify(transcript.body)}`)
assert.ok(transcript.body.segments.every((one, index, all) => index === 0 || all[index - 1].seq < one.seq))
console.log(
  "✔ liveTranscript(cursor 0) →",
  `${transcript.body.segments.length} segments, ascending, en+original present`,
)
const english = transcript.body.segments.filter((one) => typeof one.textEn === "string")
assert.ok(english.length > 0, "no translated lines among the segments")
const arabic = transcript.body.segments.filter((one) => typeof one.textAr === "string")
assert.ok(arabic.length > 0, "no Arabic lines (text_ar) among the segments")
assert.ok(
  transcript.body.segments.every((one) => (one.seq % 2 ? one.textAr === null : one.textAr === `سطر ${one.seq} بالعربية`)),
  "text_ar didn't round-trip (present on even seqs, null on odd)",
)
console.log("✔ text_ar round-trips: present where sent, null where left out")

// A cursor after everything reads empty.
const none = await rpc("liveTranscript", [sessionId, 999])
assert.equal(none.status, 200)
assert.deepEqual(none.body.segments, [])
console.log("✔ cursor past the end → empty read")

// An unauthenticated transcript read is refused.
const denied = await fetch(`${BASE}/api/rpc/liveTranscript`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ args: [sessionId, 0] }),
})
assert.equal(denied.status, 401, `anon read: ${denied.status}`)
console.log("✔ transcript without a session → RPC 401")

console.log("smoke-live: all checks passed.")
