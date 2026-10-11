/**
 * The permission matrix of docs/plan-google-sync.md §5.3: one test per row,
 * for an administrator and a member. Field edits run through the same
 * restrict → merge steps as `syncTaskCopy` / `syncMeetingCopy`.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Role } from "@/lib/types"
import type { MeetingFields, TaskFields } from "./mapping.ts"
import { diff, restrict, threeWayMerge } from "./merge.ts"
import {
  meetingFieldsFor,
  onCopyDeleted,
  onNewEventInGoogle,
  onNewTaskInGoogle,
  taskFieldsFor,
  taskSyncs,
} from "./policy.ts"

const task: TaskFields = { title: "Plan", description: "Draft", dueDate: "2026-10-14", done: false }
const meeting: MeetingFields = {
  title: "Weekly",
  notes: "Agenda",
  date: "2026-10-13",
  startTime: "09:00",
  endTime: "09:45",
  location: "Room 1",
}

/**
 * A Google-side edit to a copy Taskly hasn't changed: what Taskly takes
 * (`toLocal`), what the Google copy is patched back to (`toRemote`), and which
 * fields were blocked (they get a "reverted" notice).
 */
function editTask(role: Role | null, google: Partial<TaskFields>, ownPrivate = false) {
  const actual = { ...task, ...google }
  const { remote, blocked } = restrict(task, actual, taskFieldsFor(role, ownPrivate))
  const merged = threeWayMerge(task, task, remote, false)
  return { toLocal: merged.toLocal, toRemote: diff(actual, merged.value), blocked }
}

function editMeeting(role: Role | null, google: Partial<MeetingFields>) {
  const actual = { ...meeting, ...google }
  const { remote, blocked } = restrict(meeting, actual, meetingFieldsFor(role))
  const merged = threeWayMerge(meeting, meeting, remote, false)
  return { toLocal: merged.toLocal, toRemote: diff(actual, merged.value), blocked }
}

// ---- Tick or untick a task: applied for both ----------------------------------

test("administrator ticks a task in Google: applied", () => {
  const result = editTask("administrator", { done: true })
  assert.deepEqual(result, { toLocal: { done: true }, toRemote: {}, blocked: [] })
})

test("member ticks a task in Google: applied", () => {
  const result = editTask("member", { done: true })
  assert.deepEqual(result, { toLocal: { done: true }, toRemote: {}, blocked: [] })
})

// ---- Task title, notes or due date: admin applied, member reverted --------------

test("administrator edits a task's title, notes and due date in Google: applied", () => {
  const edit = { title: "Plan v2", description: "Final", dueDate: "2026-10-20" }
  const result = editTask("administrator", edit)
  assert.deepEqual(result, { toLocal: edit, toRemote: {}, blocked: [] })
})

test("member edits a task's title, notes or due date in Google: reverted", () => {
  const result = editTask("member", { title: "Mine now", description: "x", dueDate: "2026-12-01" })
  assert.deepEqual(result.toLocal, {})
  assert.deepEqual(result.toRemote, { title: "Plan", description: "Draft", dueDate: "2026-10-14" })
  assert.deepEqual(result.blocked, ["title", "description", "dueDate"])
})

test("member ticks and retitles at once: the tick stays, the title is reverted", () => {
  const result = editTask("member", { title: "Mine now", done: true })
  assert.deepEqual(result.toLocal, { done: true })
  assert.deepEqual(result.toRemote, { title: "Plan" })
  assert.deepEqual(result.blocked, ["title"])
})

test("member edits their own private task in Google: applied", () => {
  const edit = { title: "Mine", description: "Notes", dueDate: "2026-11-01", done: true }
  const result = editTask("member", edit, true)
  assert.deepEqual(result, { toLocal: edit, toRemote: {}, blocked: [] })
})

test("someone who can't act in the workspace: every change is reverted", () => {
  const result = editTask(null, { title: "x", done: true })
  assert.deepEqual(result.toLocal, {})
  assert.deepEqual(result.blocked, ["title", "done"])
})

// ---- Meeting title, time, location or agenda: admin applied, member reverted ----

test("administrator edits a meeting in Google: applied", () => {
  const edit = { title: "Weekly sync", startTime: "10:00", endTime: "10:30", location: "Online", notes: "New" }
  const result = editMeeting("administrator", edit)
  assert.deepEqual(result, { toLocal: edit, toRemote: {}, blocked: [] })
})

test("member edits a meeting in Google: reverted", () => {
  const result = editMeeting("member", { title: "Mine", date: "2026-10-14", location: "Home" })
  assert.deepEqual(result.toLocal, {})
  assert.deepEqual(result.toRemote, { title: "Weekly", date: "2026-10-13", location: "Room 1" })
  assert.deepEqual(result.blocked, ["title", "date", "location"])
})

// ---- New task / event in "Taskly · <Workspace>" -------------------------------

test("administrator or member adds a task in Google: it becomes their private task", () => {
  assert.equal(onNewTaskInGoogle("administrator"), "import")
  assert.equal(onNewTaskInGoogle("member"), "import")
})

test("someone who left the workspace adds a task: it moves to their own list", () => {
  assert.equal(onNewTaskInGoogle(null), "move")
})

test("administrator adds a timed single-day event: it becomes a meeting they organise", () => {
  assert.equal(onNewEventInGoogle("administrator", true), "import")
})

test("administrator adds an all-day, multi-day or repeating event: it moves to their calendar", () => {
  assert.equal(onNewEventInGoogle("administrator", false), "move")
})

test("member adds an event in Google: it moves to their primary calendar", () => {
  assert.equal(onNewEventInGoogle("member", true), "move")
})

// ---- Delete a copy in Google --------------------------------------------------

test("administrator deletes a task they created, or a meeting they organise: deleted in Taskly", () => {
  assert.equal(onCopyDeleted("administrator", true), "delete")
})

test("administrator deletes someone else's task or meeting: the copy comes back", () => {
  assert.equal(onCopyDeleted("administrator", false), "restore")
})

test("member deletes a copy: the copy comes back", () => {
  assert.equal(onCopyDeleted("member", true), "restore")
  assert.equal(onCopyDeleted("member", false), "restore")
})

test("anyone deletes the copy of their own private task: deleted in Taskly", () => {
  assert.equal(onCopyDeleted("member", true, true), "delete")
  assert.equal(onCopyDeleted("administrator", true, true), "delete")
})

// ---- Which tasks get Google copies ------------------------------------------

test("workspace tasks sync; private tasks only when their owner turned it on", () => {
  assert.equal(taskSyncs({ private: false, googleSync: false, status: "open" }), true)
  assert.equal(taskSyncs({ private: true, googleSync: true, status: "open" }), true)
  assert.equal(taskSyncs({ private: true, googleSync: false, status: "open" }), false)
  assert.equal(taskSyncs({ private: false, googleSync: false, status: "cancelled" }), false)
})
