/**
 * D1 access for Google sync: connections, containers (task lists/calendars)
 * and links (which Google copy mirrors which workspace item, for whom).
 */
import type { GoogleContainer, GoogleContainerKind } from "@/lib/types"
import { all, first, nowIso, run } from "@/server/db"

export type ConnectionRow = {
  user_id: string
  google_sub: string
  google_email: string
  refresh_token_enc: string
  access_token_enc: string | null
  access_expires_at: string | null
  scopes: string
  state: "active" | "revoked" | "error"
  last_error: string | null
  last_sync_at: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export type ContainerRow = {
  user_id: string
  kind: GoogleContainerKind
  google_id: string
  account_id: string | null
  title: string
  color: string | null
  access_role: string | null
  is_primary: number
  selected: number
  sync_token: string | null
  polled_at: string | null
  channel_id: string | null
  channel_token: string | null
  channel_resource_id: string | null
  channel_expires_at: string | null
}

export type LinkKind = "task" | "meeting"

export type LinkRow = {
  kind: LinkKind
  entity_id: string
  user_id: string
  account_id: string
  container_id: string
  google_id: string
  etag: string | null
  /** JSON of the two-way fields as both sides last agreed. */
  base: string
  footer: string
  synced_at: string
}

export function getConnection(db: D1Database, userId: string): Promise<ConnectionRow | null> {
  return first<ConnectionRow>(db, "SELECT * FROM google_connections WHERE user_id = ?", userId)
}

export function workspaceContainer(
  db: D1Database,
  userId: string,
  kind: GoogleContainerKind,
  accountId: string,
): Promise<ContainerRow | null> {
  return first<ContainerRow>(
    db,
    "SELECT * FROM google_containers WHERE user_id = ? AND kind = ? AND account_id = ?",
    userId,
    kind,
    accountId,
  )
}

/** The person's own (non-Taskly) list or calendar with this Google id. */
export function personalContainer(
  db: D1Database,
  userId: string,
  kind: GoogleContainerKind,
  googleId: string,
): Promise<ContainerRow | null> {
  return first<ContainerRow>(
    db,
    `SELECT * FROM google_containers
     WHERE user_id = ? AND kind = ? AND account_id IS NULL AND (google_id = ? OR (? = 'primary' AND is_primary = 1))`,
    userId,
    kind,
    googleId,
    googleId,
  )
}

export function containersOf(db: D1Database, userId: string): Promise<ContainerRow[]> {
  return all<ContainerRow>(
    db,
    `SELECT * FROM google_containers WHERE user_id = ?
     ORDER BY account_id IS NOT NULL, kind, is_primary DESC, title COLLATE NOCASE`,
    userId,
  )
}

export function toContainer(row: ContainerRow): GoogleContainer {
  return {
    kind: row.kind,
    id: row.google_id,
    title: row.title,
    accountId: row.account_id,
    selected: row.account_id !== null || row.selected === 1,
    color: row.color,
    primary: row.is_primary === 1,
  }
}

export function getLink(
  db: D1Database,
  kind: LinkKind,
  entityId: string,
  userId: string,
): Promise<LinkRow | null> {
  return first<LinkRow>(
    db,
    "SELECT * FROM google_links WHERE kind = ? AND entity_id = ? AND user_id = ?",
    kind,
    entityId,
    userId,
  )
}

export function linksFor(db: D1Database, kind: LinkKind, entityId: string): Promise<LinkRow[]> {
  return all<LinkRow>(db, "SELECT * FROM google_links WHERE kind = ? AND entity_id = ?", kind, entityId)
}

export function linkByGoogleId(
  db: D1Database,
  userId: string,
  googleId: string,
): Promise<LinkRow | null> {
  return first<LinkRow>(
    db,
    "SELECT * FROM google_links WHERE user_id = ? AND google_id = ?",
    userId,
    googleId,
  )
}

/** Insert or replace a link, and note that this person just synced. */
export async function saveLink(db: D1Database, link: Omit<LinkRow, "synced_at">): Promise<void> {
  const now = nowIso()
  await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO google_links
           (kind, entity_id, user_id, account_id, container_id, google_id, etag, base, footer, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        link.kind,
        link.entity_id,
        link.user_id,
        link.account_id,
        link.container_id,
        link.google_id,
        link.etag,
        link.base,
        link.footer,
        now,
      ),
    db.prepare("UPDATE google_connections SET last_sync_at = ? WHERE user_id = ?").bind(now, link.user_id),
  ])
}

export function deleteLink(db: D1Database, link: Pick<LinkRow, "kind" | "entity_id" | "user_id">) {
  return run(
    db,
    "DELETE FROM google_links WHERE kind = ? AND entity_id = ? AND user_id = ?",
    link.kind,
    link.entity_id,
    link.user_id,
  )
}

export function touchSynced(db: D1Database, userId: string): Promise<void> {
  return run(db, "UPDATE google_connections SET last_sync_at = ? WHERE user_id = ?", nowIso(), userId)
}
