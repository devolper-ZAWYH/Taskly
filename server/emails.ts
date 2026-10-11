/**
 * A person's email addresses: the primary one (users.email) plus confirmed
 * extras (user_emails). Every lookup by email (sign-in, invitations, password
 * reset, "is this address taken?") goes through here, so an unconfirmed
 * address never matches anyone.
 */
import { first, type UserRow } from "@/server/db"

/** SQL condition on `users u`: `?` (bind twice) is one of their addresses. */
export const HAS_EMAIL = `(u.email = ? OR u.id IN (
  SELECT user_id FROM user_emails WHERE email = ? AND verified_at IS NOT NULL))`

/** The (not deleted) person who owns this address, primary or confirmed extra. */
export function userByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return first<UserRow>(
    db,
    `SELECT u.* FROM users u WHERE ${HAS_EMAIL} AND u.deleted_at IS NULL`,
    email,
    email,
  )
}

/** Whether anyone but `exceptUserId` already has this address. */
export async function emailTaken(
  db: D1Database,
  email: string,
  exceptUserId = "",
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT u.id FROM users u WHERE ${HAS_EMAIL} AND u.id != ?`,
    email,
    email,
    exceptUserId,
  )
  return row !== null
}
