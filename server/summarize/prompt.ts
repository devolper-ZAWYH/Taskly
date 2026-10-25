/**
 * The summarizer's prompt and the defensive parse of its answer (docs/
 * live-meetings.md §5, Phase 3). Pure and DB-free, like server/translate/text.ts:
 * segments in, `{ system, user }` out; the model's raw reply back to a validated
 * `LiveDraftPayload` in — or a plain Error that says so, never the transcript.
 */
import type { LiveDraftActionItem, LiveDraftPayload } from "@/lib/types"

/** A plain Error (never transcript content) naming only what was wrong. */
function bad(why: string): never {
  throw new Error(`summary reply unusable (${why})`)
}

/** What one prompt line needs: exactly the segment fields used for the prompt. */
export type SummarySegment = {
  source: "mic" | "system"
  /** As spoken ("ar", "en"…), when the device knew. */
  lang: string | null
  text: string
  /** The device's English line (identical to `text` when English was spoken). */
  textEn: string | null
}

/** The transcript caps the prompt works within (a long meeting still fits). */
export const MAX_SUMMARY_SEGMENTS = 5_000
/** Characters of transcript text sent to the model at once. */
export const MAX_TRANSCRIPT_CHARS = 60_000

/** Labels for the two speaker rows ("Me" = microphone, "Them" = loopback). */
const SPEAKER: Record<"mic" | "system", string> = { mic: "Me", system: "Them" }

function isEnglish(lang: string | null): boolean {
  return typeof lang === "string" && lang.toLowerCase().startsWith("en")
}

/**
 * The transcript as the prompt reads it: one numbered block per segment, the
 * English line first (the device's `text_en`, else the text itself when English
 * was spoken) and the original line under it when the two differ. Stops at the
 * character cap; whatever it got still summarises.
 */
export function renderTranscript(segments: SummarySegment[]): string {
  const blocks: string[] = []
  let chars = 0
  for (const [index, segment] of segments.slice(0, MAX_SUMMARY_SEGMENTS).entries()) {
    const speaker = SPEAKER[segment.source] ?? segment.source
    const english = segment.textEn ?? (isEnglish(segment.lang) ? segment.text : null)
    const original = segment.text && segment.text !== english ? segment.text : null
    const lines = [
      `(${index + 1}) [${speaker}]`,
      english ? `EN: ${english}` : null,
      original ? `${(segment.lang ?? "").toUpperCase()}: ${original}` : null,
    ].filter((line): line is string => line !== null)
    const block = lines.join("\n")
    // The "\n\n" between blocks counts toward the cap too.
    chars += block.length + (blocks.length ? 2 : 0)
    if (chars > MAX_TRANSCRIPT_CHARS) break
    blocks.push(block)
  }
  return blocks.join("\n\n")
}

/**
 * What the model is asked for. The reply must be the JSON alone: fixed
 * sections, action items carrying the assignee's NAME echoed (matched later,
 * never trusted — `server/live/review.ts`), and a due date as YYYY-MM-DD.
 */
export function summaryPrompt(segments: SummarySegment[]): { system: string; user: string } {
  return {
    system: [
      "You write the minutes of a meeting from its transcript, for Taskly.",
      "The transcript lines are numbered; [Me] is the microphone (the recorder), [Them] is the meeting app's own audio.",
      "Write clear, plain business language, mixing Arabic and English as they appear in the transcript.",
      "Reply with STRICT JSON and nothing else (no markdown, no code fence, no preamble):",
      '{"summary": string, "decisions": [string], "follow_ups": [string],',
      ' "action_items": [{"title": string, "assignee": string, "due": "YYYY-MM-DD"}]}',
      "- `summary`: a tight paragraph of what the meeting covered, in the transcript's own language for what it says.",
      "- `decisions`: one item per decision reached; [] when none.",
      "- `follow_ups`: things to check back on later; [] when none.",
      "- `action_items`: every task someone took on, in the transcript's own words for the title.",
      '- `assignee`: that person\'s name exactly as the transcript says it; "" when nobody took the item; omit the key when there is none.',
      '- `due`: include the key only when the transcript gives a concrete day ("next Thursday" is not one); its value is YYYY-MM-DD.',
      "- Never invent action items, decisions or names the transcript doesn't support.",
      "- Keep each string short: the summary under 2000 characters, one line for each list item, titles under 200.",
    ].join(" "),
    user: ["Transcript of the meeting:", "", renderTranscript(segments)].join("\n"),
  }
}

/** Caps the parse mirrors (the same ones the engine's contract sets). */
const MAX_ITEMS = 30
const MAX_LIST = 25
const MAX_SUMMARY_CHARS = 20_000
const MAX_SECTION_LINE = 500
const MAX_TITLE = 200
const MAX_ASSIGNEE = 100

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Strings only, capped; a missing list is empty, a wrong one is a rejection.
 * Blank lines (models often answer "none" as `[""]`) are dropped: the stored
 * draft's own check (server/live/drafts.ts) refuses them.
 */
function lines(value: unknown, max: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) bad("a list wasn't an array")
  return value
    .map((item) => {
      if (typeof item !== "string") bad("a list item wasn't a string")
      if (item.length > max) bad("a list item was too long")
      return item.trim()
    })
    .filter((item) => item.length > 0)
}

/**
 * Turn the model's raw reply into a validated draft payload. Forgiving about
 * the wrapper (a ```json fence, a preamble, a reasoning block), strict about
 * the content: anything unsuitable throws a plain Error that names only what
 * was wrong — the transcript never surfaces in errors or logs (Phase 3 rule).
 */
export function parseSummaryDraft(raw: string): LiveDraftPayload {
  if (typeof raw !== "string" || !raw.trim()) bad("empty reply")
  const jsonFence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const candidates = [jsonFence?.[1], raw.replace(/<[^>]*think[^>]*>[\s\S]*?<[^>]*\/think[^>]*>/g, "")]
    .filter((candidate): candidate is string => typeof candidate === "string")
  const parsed = candidates
    .map((candidate) => candidate.slice(candidate.indexOf("{"), candidate.lastIndexOf("}") + 1))
    .map((candidate) => {
      try {
        return JSON.parse(candidate) as unknown
      } catch {
        return null
      }
    })
    .find(isObject)
  if (!parsed) bad("no JSON object in the reply")
  const v = parsed

  const summary = v.summary
  if (typeof summary !== "string" || !summary.trim()) bad("no summary text")
  if (summary.length > MAX_SUMMARY_CHARS) bad("the summary was too long")

  // Like the lists below: missing is empty, a wrong type is a rejection, and a
  // long list is capped rather than rejected.
  if (v.action_items !== undefined && v.action_items !== null && !Array.isArray(v.action_items)) {
    bad("action items weren't an array")
  }
  const actionRaw: unknown[] = Array.isArray(v.action_items) ? v.action_items.slice(0, MAX_ITEMS) : []
  const actionItems: LiveDraftActionItem[] = actionRaw.map((item) => {
    if (!isObject(item)) bad("an action item wasn't an object")
    const title = item.title
    if (typeof title !== "string" || !title.trim()) bad("an action item had no title")
    if (title.length > MAX_TITLE) bad("an action item title was too long")
    const one: LiveDraftActionItem = { title: title.trim() }
    const assignee = item.assignee
    if (typeof assignee === "string" && assignee.trim()) {
      if (assignee.length > MAX_ASSIGNEE) bad("an assignee name was too long")
      one.assignee = assignee.trim()
    }
    if (typeof item.due === "string" && item.due) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.due)) bad("a due date wasn't YYYY-MM-DD")
      one.due = item.due
    }
    return one
  })

  const decisions = lines(v.decisions, MAX_SECTION_LINE).slice(0, MAX_LIST)
  const followUps = lines(v.follow_ups, MAX_SECTION_LINE).slice(0, MAX_LIST)

  return { sections: { summary: summary.trim(), decisions, followUps }, actionItems }
}

/** The fixed sample the settings "Test summary" button runs through a provider. */
export const SAMPLE_TRANSCRIPT: SummarySegment[] = [
  {
    source: "mic",
    lang: "ar",
    text: "يا جماعة، لنبدأ بمراجعة مهام الأسبوع.",
    textEn: "Alright everyone, let's start with this week's task review.",
  },
  {
    source: "system",
    lang: "en",
    text: "Sure, I finished the migration and the seed. We ship the release on the 26th.",
    textEn: null,
  },
  {
    source: "mic",
    lang: "ar",
    text: "ممتاز. سارة ستتابع مع الفريق القانوني، ونراجع التأثير الأسبوع القادم.",
    textEn: "Great. Sara will follow up with the legal team, and we'll review the impact next week.",
  },
  {
    source: "system",
    lang: "en",
    text: "I'll draft the announcement document before Thursday and share it for review.",
    textEn: null,
  },
  {
    source: "mic",
    lang: "en",
    text: "One more thing: Omar prepares the demo environment for next Tuesday.",
    textEn: null,
  },
]
