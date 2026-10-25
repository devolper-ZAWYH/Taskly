/**
 * Drafts of a live session's review: the payload shape (snake-case from the
 * wire → typed camelCase) and the 15-minute expiry arithmetic. The table
 * ships ahead of the workflow, so these are pure checks like the rest here.
 *
 * The canonical shape is the nested one of docs/live-meetings.md §5:
 *   { sections: { summary, decisions[], follow_ups[] },
 *     action_items: [{ title, assignee?, due? }] }
 * The stored payload is the validated camelCase object, which round-trips
 * through this same parser when the review claims it.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { AppError } from "@/lib/api/core"
import { LIVE_DRAFT_MINUTES, draftExpiry, isDraftExpired, parseLiveDraftPayload } from "./drafts.ts"

const bad = (run: () => unknown): void => {
  assert.throws(run, (error: unknown) => error instanceof AppError && error.code === "badRequest")
}

test("a draft payload parses snake-case into typed sections", () => {
  assert.deepEqual(
    parseLiveDraftPayload({
      sections: {
        summary: "Alignment call: three decisions.",
        decisions: ["Ship on the 26th."],
        follow_ups: ["Budget call next week"],
      },
      action_items: [
        { title: "Draft the announcement", assignee: "Thouseef" },
        { title: "Book the demo" },
        { title: "Follow up with legal", assignee: "" },
      ],
    }),
    {
      sections: {
        summary: "Alignment call: three decisions.",
        decisions: ["Ship on the 26th."],
        followUps: ["Budget call next week"],
      },
      actionItems: [
        { title: "Draft the announcement", assignee: "Thouseef" },
        { title: "Book the demo" },
        { title: "Follow up with legal" },
      ],
    },
  )
})

test("the stored camelCase payload round-trips (a claimed draft re-parses)", () => {
  const stored = {
    sections: {
      summary: "Alignment call.",
      decisions: ["Ship on the 26th."],
      followUps: ["Budget call next week"],
    },
    actionItems: [{ title: "Draft the announcement" }],
  }
  assert.deepEqual(parseLiveDraftPayload(stored), stored)
})

test("a malformed draft payload is rejected", () => {
  bad(() => parseLiveDraftPayload("nope"))
  bad(() => parseLiveDraftPayload({ summary: "s", action_items: [] })) // no sections
  bad(() => parseLiveDraftPayload({ sections: "nope", action_items: [] }))
  bad(() =>
    parseLiveDraftPayload({ sections: { summary: "s", decisions: "d" }, action_items: [] }),
  )
  bad(() =>
    parseLiveDraftPayload({ sections: { summary: "s", decisions: [] }, action_items: {} }),
  )
  bad(() =>
    parseLiveDraftPayload({
      sections: { summary: "s", decisions: [] },
      action_items: ["a string"],
    }),
  )
  bad(() =>
    parseLiveDraftPayload({
      sections: { summary: "s", decisions: [], follow_ups: [1] },
      action_items: [],
    }),
  )
  bad(() =>
    parseLiveDraftPayload({
      sections: { summary: "x".repeat(20_001), decisions: [], follow_ups: [] },
      action_items: [],
    }),
  )
  bad(() =>
    parseLiveDraftPayload({
      sections: { summary: "s", decisions: [], follow_ups: [] },
      action_items: [{ title: "  " }],
    }),
  )
})

test("drafts live fifteen minutes from creation", () => {
  assert.equal(LIVE_DRAFT_MINUTES, 15)
  assert.equal(draftExpiry(0), "1970-01-01T00:15:00.000Z")
  assert.equal(draftExpiry(Date.UTC(2026, 9, 22, 9, 0)), "2026-10-22T09:15:00.000Z")
})

test("an expiry in the past (ISO compare) is expired, including exactly now", () => {
  const expiry = "2026-10-22T09:15:00.000Z"
  assert.equal(isDraftExpired(expiry, "2026-10-22T09:14:59.999Z"), false)
  assert.equal(isDraftExpired(expiry, expiry), false) // still valid at the stroke
  assert.equal(isDraftExpired(expiry, "2026-10-22T09:15:00.001Z"), true)
})
