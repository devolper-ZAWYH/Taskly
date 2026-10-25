/**
 * The summarizer's prompt and its defensive parse of a model reply: pure
 * checks (no DB, no HTTP), like server/live/review's own suite.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MAX_SUMMARY_SEGMENTS,
  MAX_TRANSCRIPT_CHARS,
  parseSummaryDraft,
  renderTranscript,
  summaryPrompt,
  type SummarySegment,
} from "./prompt.ts"

const seg = (over?: Partial<SummarySegment>): SummarySegment => ({
  source: "mic",
  lang: "en",
  text: "Hello there.",
  textEn: null,
  ...over,
})

test("the transcript renders as numbered [Me]/[Them] blocks, English first", () => {
  const out = renderTranscript([
    seg({ source: "system", lang: "ar", text: "أهلا", textEn: "Hello" }),
    seg(),
    // English spoken: the text IS the English line, no duplicate line.
    seg({ lang: "en", text: "Sure thing.", textEn: "Sure thing." }),
  ])
  const blocks = out.split("\n\n")
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks[0].split("\n"), ["(1) [Them]", "EN: Hello", "AR: أهلا"])
  assert.deepEqual(blocks[1].split("\n"), ["(2) [Me]", "EN: Hello there."])
  assert.deepEqual(blocks[2].split("\n"), ["(3) [Me]", "EN: Sure thing."])
})

test("a segment with no English line renders the original only", () => {
  const out = renderTranscript([seg({ lang: "ar", text: "مرحبا", textEn: null })])
  assert.deepEqual(out.split("\n"), ["(1) [Me]", "AR: مرحبا"])
})

test("the render stops at the character cap, keeping whatever fit", () => {
  // Ten segments, each block just over 10k characters: five fit inside 60k.
  const out = renderTranscript(
    Array.from({ length: 10 }, (_, i) => seg({ text: `x${i}`.repeat(5_000) })),
  )
  assert.ok(out.length <= MAX_TRANSCRIPT_CHARS)
  assert.ok(out.includes("(5) [Me]"))
  assert.ok(!out.includes("(6) [Me]"))
})

test("the render also caps how many segments it ever reads", () => {
  assert.equal(MAX_SUMMARY_SEGMENTS, 5_000)
  const out = renderTranscript(
    Array.from({ length: MAX_SUMMARY_SEGMENTS + 1 }, () => seg({ text: "x" })),
  )
  // Numbered 1..5000; the 5001st never made it.
  assert.ok(!out.includes("(5001)"))
})

test("the prompt asks for strict JSON with the contract's sections", () => {
  const { system, user } = summaryPrompt([seg()])
  assert.match(system, /STRICT JSON/)
  assert.match(system, /"action_items"/)
  assert.match(system, /YYYY-MM-DD/)
  assert.match(system, /assignee/)
  assert.match(user, /^Transcript of the meeting:\n\n/)
  assert.match(user, /\(1\) \[Me\]/)
})

test("a clean JSON reply parses into the draft payload", () => {
  const payload = parseSummaryDraft(
    JSON.stringify({
      summary: "Kicked off the review.",
      decisions: ["Ship on the 26th."],
      follow_ups: ["Legal call next week."],
      action_items: [
        { title: "Draft the announcement", assignee: " Sara ", due: "2026-10-24" },
        { title: "Book the demo", assignee: "", due: "" },
      ],
    }),
  )
  assert.deepEqual(payload, {
    sections: { summary: "Kicked off the review.", decisions: ["Ship on the 26th."], followUps: ["Legal call next week."] },
    actionItems: [
      { title: "Draft the announcement", assignee: "Sara", due: "2026-10-24" },
      { title: "Book the demo" },
    ],
  })
})

test("blank list lines are dropped, not stored", () => {
  const payload = parseSummaryDraft(
    JSON.stringify({ summary: "Short.", decisions: [""], follow_ups: ["  ", " Call back "] }),
  )
  assert.deepEqual(payload.sections, { summary: "Short.", decisions: [], followUps: ["Call back"] })
})

test("missing optional lists come back empty", () => {
  const payload = parseSummaryDraft(JSON.stringify({ summary: "It went fine." }))
  assert.deepEqual(payload, {
    sections: { summary: "It went fine.", decisions: [], followUps: [] },
    actionItems: [],
  })
})

test("a fenced or padded reply is unwrapped", () => {
  const body = JSON.stringify({ summary: "Done.", decisions: [], follow_ups: [], action_items: [] })
  const fenced = "```json\n" + body + "\n```"
  const padded = "Here is the summary:\n" + body + "\nAny questions?"
  assert.equal(parseSummaryDraft(fenced).sections.summary, "Done.")
  assert.equal(parseSummaryDraft(padded).sections.summary, "Done.")
  // A reasoning block is stripped before the JSON is looked for.
  const reasoned = "<think>The meeting went well…</think>\n" + body
  assert.equal(parseSummaryDraft(reasoned).sections.summary, "Done.")
})

test("an unusable reply is rejected with an error that never quotes the transcript", () => {
  const transcript = "Secret project Alpha transcript line."
  const bad = (run: () => unknown): void => {
    try {
      run()
    } catch (error) {
      assert.match(String(error), /summary reply unusable/)
      assert.ok(!String(error).includes(transcript))
      return
    }
    assert.fail("expected a rejection")
  }
  bad(() => parseSummaryDraft(""))
  bad(() => parseSummaryDraft("   "))
  bad(() => parseSummaryDraft("no braces at all"))
  bad(() => parseSummaryDraft("[1, 2, 3]"))
  bad(() => parseSummaryDraft(JSON.stringify({ summary: "  " })))
  bad(() => parseSummaryDraft(JSON.stringify({ summary: "x" + "y".repeat(20_000) })))
  bad(() => parseSummaryDraft(JSON.stringify({ summary: "ok", action_items: { title: "t" } })))
  bad(() => parseSummaryDraft(JSON.stringify({ summary: "ok", action_items: ["a string"] })))
  bad(() =>
    parseSummaryDraft(JSON.stringify({ summary: "ok", action_items: [{ title: "" }] })),
  )
  bad(() =>
    parseSummaryDraft(
      JSON.stringify({ summary: "ok", action_items: [{ title: "t".repeat(201) }] }),
    ),
  )
  bad(() =>
    parseSummaryDraft(
      JSON.stringify({ summary: "ok", action_items: [{ title: "t", assignee: "n".repeat(101) }] }),
    ),
  )
  bad(() =>
    parseSummaryDraft(
      JSON.stringify({ summary: "ok", action_items: [{ title: "t", due: "24-10-2026" }] }),
    ),
  )
  bad(() =>
    parseSummaryDraft(
      JSON.stringify({ summary: "ok", decisions: ["l".repeat(501)] }),
    ),
  )
  bad(() =>
    parseSummaryDraft(
      JSON.stringify({ summary: "ok", decisions: {} }),
    ),
  )
})

test("long lists are capped instead of rejected; item caps are too", () => {
  const payload = parseSummaryDraft(
    JSON.stringify({
      summary: "Long meeting.",
      decisions: Array.from({ length: 30 }, (_, i) => `D${i}`),
      follow_ups: Array.from({ length: 30 }, (_, i) => `F${i}`),
    }),
  )
  assert.equal(payload.sections.decisions.length, 25)
  assert.equal(payload.sections.followUps.length, 25)

  const tooMany = parseSummaryDraft(
    JSON.stringify({
      summary: "Busy.",
      action_items: Array.from({ length: 31 }, (_, i) => ({ title: `T${i}` })),
    }),
  )
  assert.equal(tooMany.actionItems.length, 30)
})
