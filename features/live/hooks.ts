"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { meetingKeys } from "@/features/calendar/hooks/use-meetings"
import { minutesKeys } from "@/features/minutes/hooks"
import { taskKeys } from "@/features/tasks/hooks/use-tasks"
import {
  liveAccept,
  liveSessions,
  liveTranscript,
  liveDraft,
  liveDiscard,
  liveSummarize,
} from "@/lib/api/live"
import type { LiveAcceptInput, LiveDraft, LiveSegment, LiveSession } from "@/lib/types"

/** The transcript panel follows behind by this much (matches translations). */
export const LIVE_POLL_MS = 3_000
/** The session list changes rarely; it only has to notice a new recording. */
const SESSIONS_POLL_MS = 10_000
/** The review draft is one small JSON; polling it open keeps the card fresh. */
export const DRAFT_POLL_MS = 5_000

const LIVE_SESSIONS_KEY = ["live", "sessions"] as const

/**
 * This meeting's recording, from the caller's own list (they record it).
 * Reads of other people's recordings would need the meeting's sessions
 * listed in `getMeeting`; the panel stays invisible without one anyway.
 */
export function useLiveSessionOfMeeting(meetingId: string | null): LiveSession | null {
  const query = useQuery({
    queryKey: LIVE_SESSIONS_KEY,
    queryFn: liveSessions,
    enabled: Boolean(meetingId),
    refetchInterval: SESSIONS_POLL_MS,
    select: (sessions: LiveSession[]): LiveSession | null =>
      meetingId
        ? (sessions
            .filter((session) => session.meetingId === meetingId)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null)
        : null,
  })
  return query.data ?? null
}

/** One transcript read returns at most this many (server/live/push.ts TRANSCRIPT_READ_LIMIT). */
const TRANSCRIPT_PAGE = 500

/**
 * The transcript, one cursor read at a time: keeps what it has seen (seq above
 * the last one), then polls for the next batch every three seconds. A full
 * page is followed at once (a long recording loads in one go); once capture
 * has stopped, the chain reads what is left and rests. A failed read keeps the
 * cursor and retries on the next tick. The result belongs to one session:
 * until the polls for a session land, what is shown is empty.
 */
export function useLiveTranscriptPoll(session: LiveSession | null): LiveSegment[] {
  const [history, setHistory] = React.useState<{ sessionId: string; segments: LiveSegment[] }>({
    sessionId: "",
    segments: [],
  })
  // Where the chain got to, so a restart (capture stopping) carries on from there.
  const seen = React.useRef<{ sessionId: string; cursor: number }>({ sessionId: "", cursor: 0 })

  // Re-anchored only when the session id or capturing changes (the sessions
  // poll makes the object identity change every few seconds; the chain must not).
  const sessionId = session?.id ?? null
  const capturing = session?.status === "capturing"
  React.useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    let timer: number | undefined
    let cursor = seen.current.sessionId === sessionId ? seen.current.cursor : 0
    let anchored = cursor > 0 // a fresh chain's first batch replaces, later ones append
    const tick = async (): Promise<void> => {
      let delay = LIVE_POLL_MS
      try {
        const batch = await liveTranscript(sessionId, cursor)
        if (cancelled) return
        if (batch.segments.length > 0) {
          cursor = batch.segments[batch.segments.length - 1].seq
          seen.current = { sessionId, cursor }
          const fresh = !anchored
          anchored = true
          setHistory((previous) => {
            const prior = !fresh && previous.sessionId === sessionId ? previous.segments : []
            return {
              sessionId,
              segments: [...prior, ...batch.segments].sort((a, b) => a.seq - b.seq),
            }
          })
        }
        if (batch.segments.length >= TRANSCRIPT_PAGE) delay = 0
        else if (!capturing) return // caught up with a finished recording
      } catch {
        // Transient (offline, session left): try again on the next tick.
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), delay)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sessionId, capturing])

  return history.sessionId === sessionId ? history.segments : []
}

/**
 * The session's review draft, polled while the card is open on a session that
 * is in review. A regenerate (a new draft row with a new handle) replaces it,
 * expiry degrades the answer to null, and a session that stopped being
 * reviewed stops polling without dropping what was shown.
 */
export function useLiveDraftPoll(
  session: LiveSession | null,
  active: boolean,
  revision = 0,
): LiveDraft | null {
  const [draft, setDraft] = React.useState<{ sessionId: string; draft: LiveDraft | null }>({
    sessionId: "",
    draft: null,
  })
  const sessionId = session?.id ?? null
  React.useEffect(() => {
    if (!sessionId || !active) return
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      try {
        const next = await liveDraft(sessionId)
        if (!cancelled) setDraft({ sessionId, draft: next })
      } catch {
        // Transient (offline): keep what we showed, try again on the next tick.
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), DRAFT_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [sessionId, active, revision])
  return draft.sessionId === sessionId ? draft.draft : null
}

// ---- Review mutations (docs/live-meetings.md §6) -----------------------------

/** The things accept changes: this meeting's minutes, its task list, and the task index. */
function useInvalidateReview(): () => void {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: minutesKeys.all })
    queryClient.invalidateQueries({ queryKey: meetingKeys.all })
    queryClient.invalidateQueries({ queryKey: taskKeys.all })
    queryClient.invalidateQueries({ queryKey: LIVE_SESSIONS_KEY })
  }
}

/** Summarize now (a service, or the engine's posted draft returned as-is). */
export function useLiveSummarize() {
  return useMutation({
    mutationFn: (sessionId: string) => liveSummarize(sessionId),
  })
}

/** Accept: the draft becomes minutes and action-item tasks. */
export function useLiveAccept() {
  const invalidate = useInvalidateReview()
  return useMutation({
    mutationFn: (input: LiveAcceptInput) => liveAccept(input),
    onSuccess: invalidate,
  })
}

/** Discard: the draft goes away, nothing is written (the session moves to done). */
export function useLiveDiscard() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => liveDiscard(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIVE_SESSIONS_KEY }),
  })
}
