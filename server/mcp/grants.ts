/**
 * Authorization codes, grants ("connections") and tokens. Every secret is a
 * random value stored only as its SHA-256. Access tokens last an hour;
 * refresh tokens last 60 days and are replaced on every use — using one twice
 * revokes the whole grant, as OAuth 2.1 recommends for public clients.
 */
import type { Ctx } from "@/server/context"
import { hashToken, newId } from "@/server/crypto"
import { all, first, nowIso, run } from "@/server/db"
import type { OAuthClient } from "@/server/mcp/clients"
import { base64url, type Scope } from "@/server/mcp/oauth-rules"

const CODE_SECONDS = 60
const ACCESS_SECONDS = 3600
const REFRESH_DAYS = 60
/** `last_used_at` is refreshed at most this often, to keep reads from writing every time. */
const TOUCH_EVERY_MS = 5 * 60_000

const secret = (prefix: string) =>
  `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

// ---- Authorization codes -------------------------------------------------------

export type CodeRow = {
  code_hash: string
  client_id: string
  user_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  resource: string
  expires_at: string
}

export async function issueCode(
  ctx: Ctx,
  input: {
    clientId: string
    userId: string
    redirectUri: string
    codeChallenge: string
    scopes: Scope[]
    resource: string
  },
): Promise<string> {
  const code = secret("tsk_code")
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(nowIso()),
    ctx.db
      .prepare(
        `INSERT INTO oauth_codes
           (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await hashToken(code),
        input.clientId,
        input.userId,
        input.redirectUri,
        input.codeChallenge,
        input.scopes.join(" "),
        input.resource,
        inSeconds(CODE_SECONDS),
      ),
  ])
  return code
}

/** Take a code out of the store (single use). Null if unknown or expired. */
export async function redeemCode(ctx: Ctx, code: string): Promise<CodeRow | null> {
  const row = await first<CodeRow>(
    ctx.db,
    "DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *",
    await hashToken(code),
  )
  return row && row.expires_at > nowIso() ? row : null
}

// ---- Grants and tokens -----------------------------------------------------------

export type TokenResponse = {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  refresh_token: string
  scope: string
}

/**
 * A new connection for this person and app. Connecting the same app again
 * replaces the earlier connection rather than piling up duplicates. Apps that
 * register afresh each time (DCR) get a new client id on every connection, so
 * for them "the same app" means the same name and host.
 */
export async function createGrant(
  ctx: Ctx,
  input: { userId: string; client: OAuthClient; scope: string; resource: string },
): Promise<string> {
  const id = newId("grant")
  const now = nowIso()
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE oauth_grants SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL
           AND (client_id = ?
             OR (? = 'dcr' AND client_id IN (SELECT client_id FROM oauth_clients WHERE kind = 'dcr')
                 AND client_name = ? AND client_host = ?))`,
      )
      .bind(
        now,
        input.userId,
        input.client.clientId,
        input.client.kind,
        input.client.name,
        input.client.host,
      ),
    ctx.db
      .prepare(
        `INSERT INTO oauth_grants
           (id, user_id, client_id, client_name, client_host, scope, resource, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.userId,
        input.client.clientId,
        input.client.name,
        input.client.host,
        input.scope,
        input.resource,
        now,
        now,
      ),
  ])
  return id
}

export async function issueTokens(ctx: Ctx, grantId: string, scope: string): Promise<TokenResponse> {
  const access = secret("tsk_at")
  const refresh = secret("tsk_rt")
  const now = nowIso()
  const insert = `INSERT INTO oauth_tokens (token_hash, grant_id, kind, scope, expires_at, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`
  await ctx.db.batch([
    // Housekeeping: this grant's expired tokens are no longer needed.
    ctx.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ? AND expires_at < ?").bind(grantId, now),
    ctx.db.prepare(insert).bind(await hashToken(access), grantId, "access", scope, inSeconds(ACCESS_SECONDS), now),
    ctx.db
      .prepare(insert)
      .bind(await hashToken(refresh), grantId, "refresh", scope, inSeconds(REFRESH_DAYS * 86_400), now),
  ])
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_SECONDS,
    refresh_token: refresh,
    scope,
  }
}

type RefreshRow = {
  grant_id: string
  used_at: string | null
  expires_at: string
  client_id: string
  grant_scope: string
  revoked_at: string | null
  user_ok: number
}

/**
 * Exchange a refresh token for a new pair. `scope` may narrow the grant's
 * scope, never widen it. Errors are OAuth error codes.
 */
export async function refreshTokens(
  ctx: Ctx,
  refreshToken: string,
  clientId: string,
  scope: string | null,
): Promise<TokenResponse | "invalid_grant" | "invalid_scope"> {
  const hash = await hashToken(refreshToken)
  const row = await first<RefreshRow>(
    ctx.db,
    `SELECT t.grant_id, t.used_at, t.expires_at, g.client_id, g.scope AS grant_scope, g.revoked_at,
            (u.active = 1 AND u.deleted_at IS NULL) AS user_ok
     FROM oauth_tokens t
     JOIN oauth_grants g ON g.id = t.grant_id
     JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = ? AND t.kind = 'refresh'`,
    hash,
  )
  if (!row || row.client_id !== clientId || row.revoked_at || !row.user_ok) return "invalid_grant"
  if (row.expires_at < nowIso()) return "invalid_grant"
  if (row.used_at) {
    // A refresh token used twice was likely stolen: end the connection.
    await revokeGrantById(ctx, row.grant_id)
    return "invalid_grant"
  }
  const allowed = row.grant_scope.split(" ")
  const asked = scope ? scope.split(/\s+/).filter(Boolean) : allowed
  if (asked.length === 0 || asked.some((s) => !allowed.includes(s))) return "invalid_scope"

  const claimed = await ctx.db
    .prepare("UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .bind(nowIso(), hash)
    .run()
  if (!claimed.meta.changes) {
    await revokeGrantById(ctx, row.grant_id)
    return "invalid_grant"
  }
  return issueTokens(ctx, row.grant_id, asked.join(" "))
}

/** Who an access token speaks for, if it is valid for `resource`. */
export type Caller = {
  userId: string
  grantId: string
  clientId: string
  scopes: string[]
  /** Seconds since the epoch. */
  expiresAt: number
}

export async function verifyAccessToken(
  ctx: Ctx,
  token: string,
  resource: string,
): Promise<Caller | null> {
  const now = nowIso()
  const row = await first<{
    grant_id: string
    user_id: string
    client_id: string
    scope: string
    resource: string
    expires_at: string
    last_used_at: string | null
  }>(
    ctx.db,
    `SELECT g.id AS grant_id, g.user_id, g.client_id, t.scope, g.resource, t.expires_at, g.last_used_at
     FROM oauth_tokens t
     JOIN oauth_grants g ON g.id = t.grant_id
     JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?
       AND g.revoked_at IS NULL AND u.active = 1 AND u.deleted_at IS NULL`,
    await hashToken(token),
    now,
  )
  // A token issued for another resource is not ours to honour.
  if (!row || row.resource !== resource) return null
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > TOUCH_EVERY_MS) {
    await run(ctx.db, "UPDATE oauth_grants SET last_used_at = ? WHERE id = ?", now, row.grant_id)
  }
  return {
    userId: row.user_id,
    grantId: row.grant_id,
    clientId: row.client_id,
    scopes: row.scope.split(" "),
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
  }
}

// ---- Revoking --------------------------------------------------------------------

async function revokeGrantById(ctx: Ctx, grantId: string): Promise<void> {
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(nowIso(), grantId),
    ctx.db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").bind(grantId),
  ])
}

/** RFC 7009: revoking either token of a grant ends the whole connection. */
export async function revokeByToken(ctx: Ctx, token: string): Promise<void> {
  const row = await first<{ grant_id: string }>(
    ctx.db,
    "SELECT grant_id FROM oauth_tokens WHERE token_hash = ?",
    await hashToken(token),
  )
  if (row) await revokeGrantById(ctx, row.grant_id)
}

/** Disconnect one of your own connections. False if it isn't yours or is already gone. */
export async function revokeGrant(ctx: Ctx, userId: string, grantId: string): Promise<boolean> {
  const row = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM oauth_grants WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    grantId,
    userId,
  )
  if (!row) return false
  await revokeGrantById(ctx, row.id)
  return true
}

/** Deactivated or deleted: every connection ends. */
export async function revokeAllGrants(ctx: Ctx, userId: string): Promise<void> {
  const now = nowIso()
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE oauth_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(now, userId),
    ctx.db
      .prepare(
        "DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE user_id = ?)",
      )
      .bind(userId),
  ])
}

export type GrantRow = {
  id: string
  client_id: string
  client_name: string
  client_host: string
  scope: string
  created_at: string
  last_used_at: string | null
}

/** Your active connections, most recently used first. */
export function activeGrants(ctx: Ctx, userId: string): Promise<GrantRow[]> {
  return all<GrantRow>(
    ctx.db,
    `SELECT id, client_id, client_name, client_host, scope, created_at, last_used_at
     FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY COALESCE(last_used_at, created_at) DESC`,
    userId,
  )
}
