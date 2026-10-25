/**
 * Who may read a live transcript. The recorder always can. Everyone else
 * follows the MEETING rules from `lib/permissions.ts`: the organizer, the
 * attendees, and workspace administrators; other members don't, and an
 * ad-hoc session (no meeting claimed) is the recorder's alone.
 */
import { canViewMeeting, type Viewer } from "@/lib/permissions"
import type { Meeting } from "@/lib/types"

export type LiveSessionAccess = { recorderId: string }

export function canReadTranscript(
  viewer: Viewer,
  session: LiveSessionAccess,
  meeting: Meeting | null,
): boolean {
  if (session.recorderId === viewer.id) return true
  return meeting !== null && canViewMeeting(viewer, meeting)
}
