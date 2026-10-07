/**
 * Browser side of Web Push: subscribe this device for the signed-in person,
 * keep the subscription bound to whoever is signed in, and drop it on sign-out.
 */
import {
  getPushPublicKey,
  removePushSubscription,
  savePushSubscription,
} from "@/lib/api/notifications"

export type PushState =
  | "unsupported" // no Push API in this browser
  | "ios-install" // iPhone/iPad Safari: only works from the Home Screen app
  | "unavailable" // server has no push keys
  | "blocked" // the person denied notifications for this site
  | "off"
  | "on"

function isIOS(): boolean {
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || iPadOS
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64 + "===".slice((base64.length + 3) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!supported()) return null
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ?? null
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return isIOS() && !isStandalone() ? "ios-install" : "unsupported"
  if (Notification.permission === "denied") return "blocked"
  return (await currentSubscription()) ? "on" : "off"
}

/** Ask permission (if needed) and subscribe this device. */
export async function enablePush(): Promise<PushState> {
  const key = await getPushPublicKey()
  if (!key) return "unavailable"
  const permission = await Notification.requestPermission()
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off"
  // The worker is normally registered at startup; register it here if not.
  if (!(await navigator.serviceWorker.getRegistration())) {
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
  }
  const registration = await navigator.serviceWorker.ready
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key),
    }))
  await savePushSubscription({ endpoint: subscription.endpoint })
  return "on"
}

/** Stop push on this device (and tell the server to forget it). */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  await removePushSubscription(subscription.endpoint).catch(() => {})
  await subscription.unsubscribe().catch(() => {})
}

/** After sign-in: make sure this device's existing subscription belongs to you. */
export async function rebindPush(): Promise<void> {
  if (!supported() || Notification.permission !== "granted") return
  const subscription = await currentSubscription()
  if (subscription) await savePushSubscription({ endpoint: subscription.endpoint }).catch(() => {})
}
