/**
 * Per-browser conveniences kept in localStorage (never app data, which lives
 * on the server).
 */

/** Remembered per user, so one person's last workspace never steers another's sign-in. */
const lastWorkspaceKey = (userId: string) => `tasks:last-workspace:${userId}`

export function getLastWorkspaceId(userId: string): string | null {
  try {
    return localStorage.getItem(lastWorkspaceKey(userId))
  } catch {
    return null
  }
}

export function setLastWorkspaceId(userId: string, id: string): void {
  try {
    localStorage.setItem(lastWorkspaceKey(userId), id)
  } catch {
    // Storage unavailable: the picker just won't preselect.
  }
}

/** "Hide for now" on the setup bar: per person, for a week. */
const setupBarKey = (userId: string) => `tasks:setup-bar-hidden:${userId}`
const SETUP_BAR_HIDE_MS = 7 * 24 * 60 * 60 * 1000

/** The setup bar's suggestions were hidden on this browser less than a week ago. */
export function getSetupBarHidden(userId: string): boolean {
  try {
    const until = Number(localStorage.getItem(setupBarKey(userId)))
    return Number.isFinite(until) && until > Date.now()
  } catch {
    return false
  }
}

export function hideSetupBar(userId: string): void {
  try {
    localStorage.setItem(setupBarKey(userId), String(Date.now() + SETUP_BAR_HIDE_MS))
  } catch {
    // Storage unavailable: the bar comes back next visit.
  }
}
