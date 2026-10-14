import { cookies } from "next/headers"
import { currentUser } from "@/server/context"
import { nowIso } from "@/server/db"
import { googleClient, googleTasksEnabled, OAUTH_COOKIE, requiredScopes } from "@/server/google/config"
import { purgeUser } from "@/server/google/containers"
import { exchangeCode, idTokenClaims, revokeToken } from "@/server/google/oauth"
import { enqueue } from "@/server/google/queue"
import { getConnection } from "@/server/google/store"
import { encryptToken, sameSecret } from "@/server/google/tokens"
import { requestContext } from "@/server/request"
import { encryptionKey } from "@/server/settings"

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

/**
 * GET /api/google/callback — Google's redirect after the consent screen.
 * Saves the connection (tokens encrypted) and queues the first sync, then
 * returns to Settings with `?google=connected` or `?google=error&reason=…`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const settings = (query: string) => redirect(`${url.origin}/settings?${query}`)
  const fail = (reason: "denied" | "scopes" | "unconfigured" | "failed") =>
    settings(`google=error&reason=${reason}`)

  const ctx = await requestContext(request)
  const jar = await cookies()
  const saved = jar.get(OAUTH_COOKIE)?.value ?? ""
  jar.delete({ name: OAUTH_COOKIE, path: "/api/google" })

  const me = await currentUser(ctx)
  if (!me) return redirect(`${url.origin}/login`)
  const client = await googleClient(ctx)
  const key = encryptionKey(ctx.env)
  if (!client || !key) return fail("unconfigured")
  if (url.searchParams.get("error")) return fail("denied")

  const [state, verifier] = saved.split(".")
  const code = url.searchParams.get("code")
  if (!state || !verifier || !code || !sameSecret(state, url.searchParams.get("state") ?? "")) {
    return fail("failed")
  }

  try {
    const tokens = await exchangeCode(
      ctx.env,
      client,
      code,
      `${url.origin}/api/google/callback`,
      verifier,
    )
    const granted = (tokens.scope ?? "").split(" ")
    const claims = idTokenClaims(tokens.id_token)
    const needed = requiredScopes(await googleTasksEnabled(ctx))
    if (!needed.every((scope) => granted.includes(scope))) {
      // They unticked something sync needs; don't keep half an access.
      await revokeToken(ctx.env, tokens.refresh_token ?? tokens.access_token)
      return fail("scopes")
    }
    if (!tokens.refresh_token || !claims) return fail("failed")

    // A different Google account than before: clear the old one out first.
    const previous = await getConnection(ctx.db, me.id)
    if (previous && previous.google_sub !== claims.sub) await purgeUser(ctx, me.id)

    const now = nowIso()
    await ctx.db
      .prepare(
        `INSERT INTO google_connections
           (user_id, google_sub, google_email, refresh_token_enc, access_token_enc, access_expires_at,
            scopes, state, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           google_sub = excluded.google_sub, google_email = excluded.google_email,
           refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc,
           access_expires_at = excluded.access_expires_at, scopes = excluded.scopes, state = 'active',
           last_error = NULL, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
      )
      .bind(
        me.id,
        claims.sub,
        claims.email,
        await encryptToken(key, tokens.refresh_token),
        await encryptToken(key, tokens.access_token),
        new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        granted.join(" "),
        now,
        now,
        now,
      )
      .run()
    // Learn their lists/calendars, create the workspace ones, copy everything in.
    await enqueue(ctx, [{ kind: "setup_user", userId: me.id }])
    return settings("google=connected")
  } catch (error) {
    console.error("google connect failed", error)
    return fail("failed")
  }
}
