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

const CLAUDE_CARD_KEY = "tasks:claude-card-dismissed"

/** The dashboard's "Use Taskly in Claude" card was dismissed on this browser. */
export function getClaudeCardDismissed(): boolean {
  try {
    return localStorage.getItem(CLAUDE_CARD_KEY) === "1"
  } catch {
    return false
  }
}

export function setClaudeCardDismissed(): void {
  try {
    localStorage.setItem(CLAUDE_CARD_KEY, "1")
  } catch {
    // Storage unavailable: the card comes back next visit.
  }
}
