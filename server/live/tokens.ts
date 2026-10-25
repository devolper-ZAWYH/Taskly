/**
 * Ending a person's live device tokens (docs/live-meetings.md §2). Leaving a
 * workspace, being deactivated or being deleted revokes them for good — the
 * rows stay (`revoked_at`, so the device reads 403), and a later re-invite or
 * reactivation never brings an old, possibly lost token back to life.
 */
import { nowIso } from "@/server/db"

/** One statement for the caller's batch: the person's tokens, in one workspace or all. */
export function revokeLiveTokensStatement(
  db: D1Database,
  userId: string,
  accountId?: string,
): D1PreparedStatement {
  return accountId === undefined
    ? db
        .prepare("UPDATE live_device_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .bind(nowIso(), userId)
    : db
        .prepare(
          `UPDATE live_device_tokens SET revoked_at = ?
           WHERE user_id = ? AND account_id = ? AND revoked_at IS NULL`,
        )
        .bind(nowIso(), userId, accountId)
}
