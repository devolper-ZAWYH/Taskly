import assert from "node:assert/strict"
import { test } from "node:test"
import { restrict, threeWayMerge } from "./merge.ts"

const base = { title: "Plan", description: "", dueDate: "2026-10-14", done: false }

test("nothing changed", () => {
  const result = threeWayMerge(base, base, base, true)
  assert.deepEqual(result, { value: base, toLocal: {}, toRemote: {}, conflicts: [] })
})

test("a change on one side goes to the other", () => {
  const local = { ...base, title: "Plan v2" }
  const remote = { ...base, done: true }
  const result = threeWayMerge(base, local, remote, false)
  assert.deepEqual(result.value, { ...base, title: "Plan v2", done: true })
  assert.deepEqual(result.toLocal, { done: true })
  assert.deepEqual(result.toRemote, { title: "Plan v2" })
  assert.deepEqual(result.conflicts, [])
})

test("the same change on both sides is not a conflict", () => {
  const both = { ...base, dueDate: "2026-10-20" }
  const result = threeWayMerge(base, both, both, false)
  assert.deepEqual(result.toLocal, {})
  assert.deepEqual(result.toRemote, {})
  assert.deepEqual(result.conflicts, [])
})

test("a conflict goes to the newer side", () => {
  const local = { ...base, title: "Local" }
  const remote = { ...base, title: "Remote" }
  assert.equal(threeWayMerge(base, local, remote, true).value.title, "Local")
  const remoteWins = threeWayMerge(base, local, remote, false)
  assert.equal(remoteWins.value.title, "Remote")
  assert.deepEqual(remoteWins.toLocal, { title: "Remote" })
  assert.deepEqual(remoteWins.conflicts, ["title"])
})

test("blocked Google changes are pushed back over", () => {
  const remote = { ...base, title: "Member edit", done: true }
  const { remote: allowed, blocked } = restrict(base, remote, ["done"])
  assert.deepEqual(blocked, ["title"])
  const result = threeWayMerge(base, base, allowed, false)
  assert.deepEqual(result.toLocal, { done: true })
  // The copy still says "Member edit": the merge diff against the real remote reverts it.
  assert.deepEqual(threeWayMerge(base, base, allowed, false).value.title, "Plan")
})
