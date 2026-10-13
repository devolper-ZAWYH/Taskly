/**
 * Review drafts: what a review step checked, held for 15 minutes under a
 * random handle. The matching write tool takes the handle, not the details,
 * so what gets created is exactly what the person was shown and confirmed.
 */
import type { Ctx } from "@/server/context"
import { first, nowIso } from "@/server/db"
import { base64url } from "@/server/mcp/oauth-rules"

const DRAFT_MINUTES = 15

export type DraftKind = "delegation" | "meeting"

export async function saveDraft(
  ctx: Ctx,
  draft: { userId: string; accountId: string; kind: DraftKind; payload: unknown },
): Promise<string> {
  const id = `draft_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`
  const now = nowIso()
  await ctx.db.batch([
    // Housekeeping: this person's expired drafts.
    ctx.db.prepare("DELETE FROM mcp_drafts WHERE user_id = ? AND expires_at < ?").bind(draft.userId, now),
    ctx.db
      .prepare(
        `INSERT INTO mcp_drafts (id, user_id, account_id, kind, payload, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        draft.userId,
        draft.accountId,
        draft.kind,
        JSON.stringify(draft.payload),
        new Date(Date.now() + DRAFT_MINUTES * 60_000).toISOString(),
        now,
      ),
  ])
  return id
}

/**
 * Take a draft out (single use). Null unless it exists, belongs to this
 * person and workspace, is of this kind, and hasn't expired.
 */
export async function takeDraft<T>(
  ctx: Ctx,
  draft: { id: string; userId: string; accountId: string; kind: DraftKind },
): Promise<T | null> {
  const row = await first<{ payload: string; expires_at: string }>(
    ctx.db,
    `DELETE FROM mcp_drafts WHERE id = ? AND user_id = ? AND account_id = ? AND kind = ?
     RETURNING payload, expires_at`,
    draft.id,
    draft.userId,
    draft.accountId,
    draft.kind,
  )
  if (!row || row.expires_at < nowIso()) return null
  return JSON.parse(row.payload) as T
}
