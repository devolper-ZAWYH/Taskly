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
