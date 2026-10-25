/**
 * The live review's accept rules (server/live/review.ts): who an action item's
 * task goes to, what the minutes' body reads, and the card's per-item edits.
 * Pure checks, no DB, like the other server/live suites.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { AppError } from "@/lib/api/core"
import type { Match } from "@/server/mcp/match"
import { composeMinutesBody, parseAcceptItems, planActionTask } from "./review.ts"

const omar = { id: "u-omar", name: "Omar Haddad", email: "omar@example.com" }
const found = (quality: "exact" | "name" | "similar" = "name"): Match => ({
  kind: "found",
  person: omar,
  quality,
})

const plan = (over: Partial<Parameters<typeof planActionTask>[0]>) =>
  planActionTask({
    actorId: "u-admin",
    actorRole: "administrator",
    item: { title: "Prepare the demo" },
    resolved: null,
    meetingId: "m-1",
    ...over,
  }).input

test("an administrator assigns the person the transcript names", () => {
  const input = plan({ item: { title: "Prepare the demo", assignee: "Omar" }, resolved: found() })
  assert.deepEqual(input.assigneeIds, ["u-omar"])
  assert.equal(input.private, false)
  assert.equal(input.meetingId, "m-1")
  assert.equal(input.description, "")
})

test("an administrator's unmatched name stays an unassigned workspace task, with a note", () => {
  const input = plan({
    item: { title: "Book the venue", assignee: "Nobody Known" },
    resolved: { kind: "missing", query: "Nobody Known" },
  })
  assert.deepEqual(input.assigneeIds, [])
  assert.equal(input.private, false)
  assert.match(input.description, /Nobody Known/)
})

test("the card's pick wins over the name heard, and null clears it", () => {
  const picked = plan({
    item: { title: "t", assignee: "Omar" },
    resolved: found(),
    override: { assigneeId: "u-sara" },
  })
  assert.deepEqual(picked.assigneeIds, ["u-sara"])
  const cleared = plan({ item: { title: "t", assignee: "Omar" }, resolved: found(), override: { assigneeId: null } })
  assert.deepEqual(cleared.assigneeIds, [])
  assert.equal(cleared.private, false)
})

test("a member's item that names someone else becomes the member's private task", () => {
  const input = plan({
    actorId: "u-daniel",
    actorRole: "member",
    item: { title: "Prepare the demo", assignee: "Omar" },
    resolved: found(),
  })
  // An unassigned workspace task would be invisible to the member who made it.
  assert.equal(input.private, true)
  assert.deepEqual(input.assigneeIds, ["u-daniel"])
  assert.match(input.description, /needs an administrator/)
})

test("a member's item with no name at all is also theirs, privately", () => {
  const input = plan({ actorId: "u-daniel", actorRole: "member", item: { title: "Follow up" } })
  assert.equal(input.private, true)
  assert.deepEqual(input.assigneeIds, ["u-daniel"])
})

test("a member's own item stays a workspace task assigned to them", () => {
  const input = plan({
    actorId: "u-omar",
    actorRole: "member",
    item: { title: "Prepare the demo", assignee: "Omar" },
    resolved: found(),
  })
  assert.equal(input.private, false)
  assert.deepEqual(input.assigneeIds, ["u-omar"])
})

test("due dates: the draft's, unless the card changed or cleared it", () => {
  assert.equal(plan({ item: { title: "t", due: "2026-10-27" } }).dueDate, "2026-10-27")
  assert.equal(plan({ item: { title: "t", due: "2026-10-27" }, override: { due: "2026-11-02" } }).dueDate, "2026-11-02")
  assert.equal(plan({ item: { title: "t", due: "2026-10-27" }, override: { due: null } }).dueDate, "")
})

test("the card's items are validated: shape, cap and dates", () => {
  assert.deepEqual(parseAcceptItems(undefined, 30), [])
  assert.deepEqual(parseAcceptItems([null, { assigneeId: "u-omar", due: null }], 30), [
    {},
    { assigneeId: "u-omar", due: null },
  ])
  const bad = (value: unknown) =>
    assert.throws(
      () => parseAcceptItems(value, 2),
      (error: unknown) => error instanceof AppError && error.code === "badRequest",
    )
  bad({})
  bad([{}, {}, {}])
  bad(["x"])
  bad([{ due: "27-10-2026" }])
})

test("the minutes' body: summary, then the lists that have items, then the note", () => {
  const body = composeMinutesBody(
    {
      sections: { summary: "Weekly review.", decisions: ["Ship on the 26th."], followUps: [] },
      actionItems: [],
    },
    "en",
    "Thanks all.",
  )
  assert.equal(body, "Weekly review.\n\nDecisions\n- Ship on the 26th.\n\nNotes\n- Thanks all.")
  // Nothing to write at all reads as empty (the service then refuses, unspent).
  assert.equal(
    composeMinutesBody({ sections: { summary: "", decisions: [], followUps: [] }, actionItems: [] }, "en"),
    "",
  )
})
