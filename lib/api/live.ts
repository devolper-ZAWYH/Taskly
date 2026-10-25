import { rpc } from "@/lib/api/rpc"
import type {
  LiveAcceptResult,
  LiveDeviceToken,
  LiveDeviceTokenSecret,
  LiveDraft,
  LiveSession,
  LiveTranscript,
  MinutesVisibility,
} from "@/lib/types"

export type {
  LiveAcceptResult,
  LiveDeviceToken,
  LiveDeviceTokenSecret,
  LiveDraft,
  LiveSession,
  LiveSegment,
  LiveSessionStatus,
  LiveSource,
  LiveTranscript,
} from "@/lib/types"

/**
 * The recordings this person made (Settings shows none of them; the meeting
 * panel's live transcript starts here), newest first.
 */
export const liveSessions = (): Promise<LiveSession[]> => rpc("liveSessions")

/**
 * A transcript past a cursor (segments with `seq > afterSeq`, ascending).
 * Permission: the recorder; else the meeting's organizer, attendees and
 * workspace administrators.
 */
export const liveTranscript = (sessionId: string, afterSeq?: number): Promise<LiveTranscript> =>
  rpc("liveTranscript", sessionId, afterSeq)

/**
 * Create a device token for one workspace (Settings → Live capture): the raw
 * token is in the response exactly once (`token`); only its hash is stored.
 */
export const createLiveDeviceToken = (params: {
  name: string
  workspaceId?: string
}): Promise<LiveDeviceTokenSecret> => rpc("createLiveDeviceToken", params)

/** The devices that can record as this person, newest first. */
export const liveDeviceTokens = (): Promise<LiveDeviceToken[]> => rpc("liveDeviceTokens")

/** Revoke a device: (unknown, foreign or already revoked) is an error. */
export const deleteLiveDeviceToken = (id: string): Promise<void> =>
  rpc("deleteLiveDeviceToken", id)

// ---- Review (docs/live-meetings.md §6): all four are recorder-only ----------

/**
 * Summarize the session into a review draft: with a summarizer service set up
 * the server does the work; otherwise (`on_device`) this returns the draft the
 * desktop engine posted, or errors with `summarizerUnavailable`.
 */
export const liveSummarize = (sessionId: string): Promise<{ draft: LiveDraft }> =>
  rpc("liveSummarize", sessionId)

/** The session's current review draft (a poll the card repeats), or null. */
export const liveDraft = (sessionId: string): Promise<LiveDraft | null> =>
  rpc("liveDraft", { sessionId })

/** Accept: write the minutes and every action-item task; consumes the draft. */
export const liveAccept = (input: {
  sessionId: string
  draftId?: string
  visibility: MinutesVisibility
  sharedWithIds?: string[]
  note?: string
  items?: { assigneeId?: string | null; due?: string | null }[]
}): Promise<LiveAcceptResult> => rpc("liveAccept", input)

/** Discard: drop the draft without writing anything; the review closes. */
export const liveDiscard = (sessionId: string): Promise<LiveSession> =>
  rpc("liveDiscard", { sessionId })
