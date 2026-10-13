/**
 * Photo links for Claude's cards. A card can't use the Taskly session cookie,
 * so each tool result that shows people gets one random link token. The
 * avatar route accepts it in place of the cookie, as the same person: it
 * shows photos only, for an hour, while the Claude connection is active.
 */
import type { Ctx } from "@/server/context"
import { hashToken } from "@/server/crypto"
import { first, nowIso } from "@/server/db"
import type { Caller } from "@/server/mcp/grants"
import { base64url } from "@/server/mcp/oauth-rules"

const LINK_MINUTES = 60

/**
 * Makes absolute photo URLs for this caller, from the app's own avatar paths
 * (`/api/avatar/<id>?v=…`). The token is created on first use, so results
 * without photos cost nothing.
 */
export function photoLinks(ctx: Ctx, caller: Caller, origin: string) {
  let token: Promise<string> | null = null
  const issue = async () => {
    const value = `tsk_pl_${base64url(crypto.getRandomValues(new Uint8Array(24)))}`
    const now = nowIso()
    await ctx.db.batch([
      // Housekeeping: this person's expired links.
      ctx.db.prepare("DELETE FROM mcp_photo_links WHERE user_id = ? AND expires_at < ?").bind(caller.userId, now),
      ctx.db
        .prepare("INSERT INTO mcp_photo_links (token_hash, user_id, grant_id, expires_at) VALUES (?, ?, ?, ?)")
        .bind(
          await hashToken(value),
          caller.userId,
          caller.grantId,
          new Date(Date.now() + LINK_MINUTES * 60_000).toISOString(),
        ),
    ])
    return value
  }
  return async (avatarPath: string | null): Promise<string | null> => {
    if (!avatarPath) return null
    token ??= issue()
    return `${origin}${avatarPath}&pt=${encodeURIComponent(await token)}`
  }
}

/** Whose photo link this is, if it is valid: unexpired, and its Claude connection still active. */
export async function photoLinkViewer(ctx: Ctx, token: string | null): Promise<string | null> {
  if (!token?.startsWith("tsk_pl_")) return null
  const row = await first<{ user_id: string }>(
    ctx.db,
    `SELECT l.user_id FROM mcp_photo_links l
     JOIN oauth_grants g ON g.id = l.grant_id AND g.revoked_at IS NULL
     JOIN users u ON u.id = l.user_id AND u.active = 1 AND u.deleted_at IS NULL
     WHERE l.token_hash = ? AND l.expires_at > ?`,
    await hashToken(token),
    nowIso(),
  )
  return row?.user_id ?? null
}
