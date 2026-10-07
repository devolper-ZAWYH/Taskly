"use client"

/**
 * One shared view of "can this browser install Taskly right now?". Chromium
 * fires `beforeinstallprompt` once per page load, often before React mounts,
 * so we start listening as soon as this module loads and keep the event for
 * both the install card and Settings.
 */
import { useSyncExternalStore } from "react"

/** Chromium's install event (not in the DOM typings yet). */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export type InstallState = {
  /** The browser offered installation; `promptInstall()` will open its dialog. */
  canPrompt: boolean
  /** Running as the installed app, or installed during this visit. */
  installed: boolean
}

const SERVER_STATE: InstallState = { canPrompt: false, installed: false }
let deferred: BeforeInstallPromptEvent | null = null
let state: InstallState = SERVER_STATE
const listeners = new Set<() => void>()

function emit(next: Partial<InstallState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** iPhone/iPad Safari has no install event; people add it from the Share menu. */
export function isIOS(): boolean {
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || iPadOS
}

if (typeof window !== "undefined") {
  state = { canPrompt: false, installed: isStandalone() }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault() // we show our own prompt instead of the mini-infobar
    deferred = event as BeforeInstallPromptEvent
    emit({ canPrompt: true })
  })
  window.addEventListener("appinstalled", () => {
    deferred = null
    emit({ canPrompt: false, installed: true })
  })
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => SERVER_STATE,
  )
}

/** Open the browser's install dialog (once per offer). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred
  if (!event) return "unavailable"
  deferred = null
  await event.prompt()
  const { outcome } = await event.userChoice
  emit({ canPrompt: false, installed: outcome === "accepted" || state.installed })
  return outcome
}
