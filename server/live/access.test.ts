/**
 * The read matrix one row per case (docs/live-meetings.md): the recorder
 * always reads; a claimed session follows the MEETING rules — organizer,
 * attendees, workspace administrators; a member who isn't part of the
 * meeting doesn't; an ad-hoc session (no meeting) is the recorder's alone.
 * Workspace membership itself (left members, other workspaces) is hidden one
 * step earlier, in `viewerInAccount` of server/services/live.ts, so it isn't
 * repeated here.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Meeting } from "@/lib/types"
import { canReadTranscript } from "./access.ts"

const account = "account-1"
const recorder = "user-rec"
const organizer = "user-org"
const attendee = "user-att"
const outsiderMember = "user-out"

const meeting: Meeting = {
  id: "meeting-1",
  accountId: account,
  title: "Quarterly directions",
  notes: "",
  date: "2026-10-22",
  startTime: "",
  endTime: "",
  location: "",
  attendeeIds: [organizer, attendee],
  organizerId: organizer,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

const session = { recorderId: recorder }
const reads = (viewer: { id: string; role: "administrator" | "member" }, claimed: Meeting | null) =>
  canReadTranscript(viewer, session, claimed)

test("the recorder always reads their own transcript, claimed or not", () => {
  assert.equal(reads({ id: recorder, role: "member" }, meeting), true)
  assert.equal(reads({ id: recorder, role: "member" }, null), true)
})

test("an ad-hoc session (no meeting claimed) is the recorder's alone", () => {
  // Not even a workspace administrator reads someone else's ad-hoc recording.
  assert.equal(canReadTranscript({ id: "someone-else", role: "administrator" }, session, null), false)
  assert.equal(reads({ id: organizer, role: "administrator" }, null), false)
  assert.equal(reads({ id: attendee, role: "member" }, null), false)
})

test("the meeting's organizer, attendees and administrators read a claimed session", () => {
  assert.equal(reads({ id: organizer, role: "member" }, meeting), true)
  assert.equal(reads({ id: attendee, role: "member" }, meeting), true)
  assert.equal(reads({ id: "admin-1", role: "administrator" }, meeting), true)
})

test("a member who isn't part of the meeting doesn't read it", () => {
  assert.equal(reads({ id: outsiderMember, role: "member" }, meeting), false)
})
