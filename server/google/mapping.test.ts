import assert from "node:assert/strict"
import { test } from "node:test"
import type { Meeting, Task } from "@/lib/types"
import {
  actionItemLines,
  eventFields,
  eventGuestEmails,
  eventSourceKey,
  FOOTER_MARK,
  footerTaskId,
  googleEventBody,
  googleTaskBody,
  googleTaskFields,
  importableFields,
  meetingFields,
  noteBody,
  statusFromDone,
  taskFields,
  wallClock,
  withFooter,
} from "./mapping.ts"

const task: Task = {
  id: "t-1",
  accountId: "acc",
  title: "Send the proposal",
  description: "Draft is in the shared folder.",
  status: "in_progress",
  priority: "high",
  startDate: "",
  startTime: "",
  dueDate: "2026-10-14",
  dueTime: "14:30",
  assigneeIds: ["u-1"],
  createdById: "u-2",
  meetingId: null,
  private: false,
  googleSync: false,
  completedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

const meeting: Meeting = {
  id: "m-1",
  accountId: "acc",
  title: "Weekly sync",
  notes: "1. Pipeline\n2. Hiring",
  date: "2026-10-13",
  startTime: "09:00",
  endTime: "09:45",
  location: "Room 2",
  attendeeIds: ["u-1"],
  organizerId: "u-2",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

test("a task survives the round trip through its Google copy", () => {
  const fields = taskFields(task)
  const body = googleTaskBody(fields, ["Due at 14:30", "Open in Taskly: https://x"])
  assert.equal(body.title, "Send the proposal")
  assert.equal(body.due, "2026-10-14T00:00:00.000Z")
  assert.equal(body.status, "needsAction")
  assert.deepEqual(googleTaskFields({ id: "g", ...body }), fields)
})

test("Google task without a due date or notes", () => {
  assert.deepEqual(googleTaskFields({ id: "g", title: "  Call Omar ", status: "completed" }), {
    title: "Call Omar",
    description: "",
    dueDate: "",
    done: true,
  })
})

test("clearing done reopens only completed tasks", () => {
  assert.equal(statusFromDone(true, "on_hold"), "completed")
  assert.equal(statusFromDone(false, "completed"), "open")
  assert.equal(statusFromDone(false, "in_progress"), "in_progress")
})

test("the footer is ignored on the way back, even after Google turns it into HTML", () => {
  const text = withFooter("Line one\nLine two", ["Priority: High"])
  assert.equal(noteBody(text), "Line one\nLine two")
  const html = `Line one<br>Line two<br><br>${FOOTER_MARK}<br>Priority: High`
  assert.equal(noteBody(html), "Line one\nLine two")
  assert.equal(noteBody("<p>A &amp; B</p><ul><li>one</li></ul>"), "A & B\n- one")
  assert.equal(noteBody("a < b and c > d"), "a < b and c > d")
})

test("a meeting survives the round trip through its Google event", () => {
  const fields = meetingFields(meeting)
  const body = googleEventBody(fields, "Asia/Qatar", ["Attendees: Omar"], {
    meetingId: meeting.id,
    accountId: meeting.accountId,
  })
  // What Google sends back: an instant with the zone's offset (Qatar is UTC+3).
  const event = {
    id: "e",
    summary: body.summary,
    description: body.description,
    location: body.location,
    start: { dateTime: "2026-10-13T09:00:00+03:00", timeZone: "Asia/Qatar" },
    end: { dateTime: "2026-10-13T09:45:00+03:00", timeZone: "Asia/Qatar" },
  }
  assert.deepEqual(eventFields(event, "Asia/Qatar"), fields)
})

test("events Taskly can't hold as meetings", () => {
  const base = { id: "e", summary: "x" }
  const timed = (start: string, end: string) => ({
    ...base,
    start: { dateTime: start },
    end: { dateTime: end },
  })
  assert.equal(eventFields({ ...base, start: { date: "2026-10-13" }, end: { date: "2026-10-14" } }, "UTC"), null)
  assert.equal(eventFields(timed("2026-10-13T22:00:00Z", "2026-10-14T01:00:00Z"), "UTC"), null)
  assert.equal(eventFields({ ...timed("2026-10-13T09:00:00Z", "2026-10-13T10:00:00Z"), recurringEventId: "r" }, "UTC"), null)
  assert.equal(eventFields({ ...timed("2026-10-13T09:00:00Z", "2026-10-13T10:00:00Z"), status: "cancelled" }, "UTC"), null)
  assert.notEqual(eventFields(timed("2026-10-13T09:00:00Z", "2026-10-13T10:00:00Z"), "UTC"), null)
})

test("wall clock follows the zone", () => {
  assert.deepEqual(wallClock(new Date("2026-10-13T21:30:00Z"), "Asia/Karachi"), {
    date: "2026-10-14",
    time: "02:30",
  })
})

test("a Google copy is traced back to its task by the footer link", () => {
  const notes = withFooter("Mine", ["Open in Taskly: https://x/w/acc/tasks?task=t-1a2b-3c"])
  assert.equal(footerTaskId(notes), "t-1a2b-3c")
  // A link above the footer is the person's own text, not Taskly's.
  assert.equal(footerTaskId("see https://x/w/acc/tasks?task=t-9"), null)
  assert.equal(footerTaskId(""), null)
})

test("action items in a meeting's Google copy", () => {
  const words = { dueOn: ", due {date}", more: "+{count} more in Taskly" }
  const items = [
    { title: "Sales report", done: false, names: ["Omar", "Sara"], due: "2026-10-20" },
    { title: "Book the room", done: false, names: [], due: "" },
    { title: "Send agenda", done: true, names: ["Sara"], due: "2026-10-10" },
  ]
  assert.deepEqual(actionItemLines(items, words, 10), [
    "• Sales report — Omar, Sara, due 2026-10-20",
    "• Book the room",
    "✓ Send agenda — Sara",
  ])
  assert.deepEqual(actionItemLines(items, words, 2), [
    "• Sales report — Omar, Sara, due 2026-10-20",
    "• Book the room",
    "+1 more in Taskly",
  ])
  // Arabic words keep their own punctuation.
  assert.deepEqual(actionItemLines([items[0]], { dueOn: "، الاستحقاق {date}", more: "" }, 10), [
    "• Sales report — Omar, Sara، الاستحقاق 2026-10-20",
  ])
})

test("an event added to a workspace is recognised in every guest's calendar", () => {
  // The same event read from two calendars in different zones.
  const inDoha = { id: "a1", iCalUID: "uid-1@google.com", start: { dateTime: "2026-10-14T14:30:00+03:00" } }
  const moved = { id: "a1", iCalUID: "uid-1@google.com", start: { dateTime: "2026-10-15T09:00:00+03:00" } }
  // The organiser moving it doesn't make it a different event.
  assert.equal(eventSourceKey(inDoha), eventSourceKey(moved))
  assert.equal(eventSourceKey(inDoha), "uid-1@google.com")
  // Occurrences of a repeating event, read in different zones, keep their original start.
  const inLondon = { id: "r_1", iCalUID: "uid-r", recurringEventId: "r", originalStartTime: { dateTime: "2026-10-14T10:00:00+01:00" } }
  const inQatar = { id: "r_1", iCalUID: "uid-r", recurringEventId: "r", originalStartTime: { dateTime: "2026-10-14T12:00:00+03:00" } }
  assert.equal(eventSourceKey(inLondon), eventSourceKey(inQatar))
  // Occurrences of a repeating event share the iCalUID but not the original start.
  const week1 = { id: "r_1", iCalUID: "uid-r", recurringEventId: "r", originalStartTime: { dateTime: "2026-10-14T09:00:00Z" } }
  const week2 = { id: "r_2", iCalUID: "uid-r", recurringEventId: "r", originalStartTime: { dateTime: "2026-10-21T09:00:00Z" } }
  assert.notEqual(eventSourceKey(week1), eventSourceKey(week2))
})

test("an event's people: organiser and guests, not rooms", () => {
  assert.deepEqual(
    eventGuestEmails({
      id: "e",
      organizer: { email: "Youssef@Client.com" },
      attendees: [
        { email: "youssef@client.com" },
        { email: "Fouziya@Zawyh.com" },
        { email: "room-2@resource.calendar.google.com", resource: true },
        { email: "me@gmail.com", self: true },
      ],
    }),
    ["youssef@client.com", "fouziya@zawyh.com"],
  )
})

test("one occurrence of a repeating event can become a meeting; all-day events can't", () => {
  const occurrence = {
    id: "r_1",
    summary: "Weekly sync",
    recurringEventId: "r",
    start: { dateTime: "2026-10-14T11:30:00Z" },
    end: { dateTime: "2026-10-14T12:00:00Z" },
  }
  assert.deepEqual(importableFields(occurrence, "Asia/Qatar"), {
    title: "Weekly sync",
    notes: "",
    date: "2026-10-14",
    startTime: "14:30",
    endTime: "15:00",
    location: "",
  })
  assert.equal(importableFields({ id: "d", start: { date: "2026-10-14" }, end: { date: "2026-10-15" } }, "UTC"), null)
})

test("Taskly's own copies of meetings are never added again", () => {
  const copy = {
    id: "c",
    start: { dateTime: "2026-10-14T11:30:00Z" },
    end: { dateTime: "2026-10-14T12:00:00Z" },
    extendedProperties: { private: { tasklyMeetingId: "m-1", tasklyAccountId: "acc-1" } },
  }
  assert.equal(importableFields(copy, "UTC"), null)
})
