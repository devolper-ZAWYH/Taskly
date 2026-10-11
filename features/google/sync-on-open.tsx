"use client"

import * as React from "react"
import { useCurrentUser } from "@/features/auth/use-auth"
import { useGoogleConnected, useSyncGoogleNow } from "@/features/google/hooks"

const MIN_INTERVAL_MS = 60_000

/** Per person and per tab, so reloads within a minute don't each ask Google again. */
const lastSyncKey = (userId: string) => `taskly:google-sync:${userId}`

function readLastSync(userId: string): number {
  try {
    return Number(sessionStorage.getItem(lastSyncKey(userId))) || 0
  } catch {
    return 0
  }
}

function writeLastSync(userId: string, at: number): void {
  try {
    sessionStorage.setItem(lastSyncKey(userId), String(at))
  } catch {
    // Storage unavailable: we may sync again on the next open, which is harmless.
  }
}

/**
 * Pulls Google changes once when the app opens (Google Tasks has no push, so
 * this is how ticks made in Google show up quickly). Renders nothing, never
 * blocks the page, and stays quiet if it fails.
 */
export function GoogleSyncOnOpen(): null {
  const me = useCurrentUser()
  const connected = useGoogleConnected()
  const { mutate } = useSyncGoogleNow()
  const started = React.useRef(false)

  React.useEffect(() => {
    if (!connected || started.current) return
    started.current = true
    const now = Date.now()
    if (now - readLastSync(me.id) < MIN_INTERVAL_MS) return
    writeLastSync(me.id, now)
    mutate(false)
  }, [connected, me.id, mutate])

  return null
}
