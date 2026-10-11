/**
 * Calls to Google APIs as one person. Keeps their access token fresh (cached,
 * encrypted, in `google_connections`), retries once on 401, and turns Google
 * errors into `GoogleError`. A refused refresh token marks the connection
 * revoked and tells the person to reconnect.
 */
import { AppError } from "@/lib/api/core"
import type { Ctx } from "@/server/context"
import { nowIso, run } from "@/server/db"
import { apiOrigin, googleClient, type GoogleClient } from "@/server/google/config"
import { OAuthGrantError, refreshAccessToken } from "@/server/google/oauth"
import { getConnection, type ConnectionRow } from "@/server/google/store"
import { decryptToken, encryptToken } from "@/server/google/tokens"
import { encryptionKey } from "@/server/settings"
import { notify } from "@/server/services/notifications"

export class GoogleError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message)
    this.name = "GoogleError"
  }

  /** Worth retrying later: rate limits, or Google having a bad moment. */
  get retryable(): boolean {
    return (
      this.status >= 500 ||
      this.status === 408 ||
      this.status === 429 ||
      (this.status === 403 && /rate|quota/i.test(this.reason))
    )
  }
}

/** The item (or list/calendar) is gone on Google's side. */
export function isGone(error: unknown): boolean {
  return error instanceof GoogleError && (error.status === 404 || error.status === 410)
}

type Query = Record<string, string | number | boolean | null | undefined>
type Method = "GET" | "POST" | "PATCH" | "DELETE"

export type Google = {
  userId: string
  call<T>(method: Method, path: string, options?: { query?: Query; body?: unknown }): Promise<T>
}

// One client per person per request/cron run, so the token is fetched once.
const clients = new WeakMap<Ctx, Map<string, Promise<Google>>>()

/** A Google client acting as `userId`. Throws `googleNotConnected` or `googleReconnect`. */
export function googleFor(ctx: Ctx, userId: string): Promise<Google> {
  let perCtx = clients.get(ctx)
  if (!perCtx) clients.set(ctx, (perCtx = new Map()))
  let client = perCtx.get(userId)
  if (!client) {
    client = createClient(ctx, userId)
    perCtx.set(userId, client)
    // A failed lookup shouldn't stick for the rest of the run.
    client.catch(() => perCtx.delete(userId))
  }
  return client
}

async function createClient(ctx: Ctx, userId: string): Promise<Google> {
  const connection = await getConnection(ctx.db, userId)
  if (!connection) throw new AppError("googleNotConnected")
  if (connection.state === "revoked") throw new AppError("googleReconnect")
  const configured = await googleClient(ctx)
  const key = encryptionKey(ctx.env)
  if (!configured || !key) throw new AppError("googleNotConfigured")
  const client: GoogleClient = configured
  const secret: string = key

  let cached: string | null = null
  const soon = () => new Date(Date.now() + 60_000).toISOString()

  async function accessToken(force: boolean): Promise<string> {
    if (!force && cached) return cached
    if (
      !force &&
      connection!.access_token_enc &&
      connection!.access_expires_at &&
      connection!.access_expires_at > soon()
    ) {
      return (cached = await decryptToken(secret, connection!.access_token_enc))
    }
    try {
      const refreshToken = await decryptToken(secret, connection!.refresh_token_enc)
      const fresh = await refreshAccessToken(ctx.env, client, refreshToken)
      const expires = new Date(Date.now() + fresh.expires_in * 1000).toISOString()
      const encrypted = await encryptToken(secret, fresh.access_token)
      await run(
        ctx.db,
        `UPDATE google_connections SET access_token_enc = ?, access_expires_at = ?, state = 'active',
           last_error = NULL, updated_at = ? WHERE user_id = ?`,
        encrypted,
        expires,
        nowIso(),
        userId,
      )
      connection!.access_token_enc = encrypted
      connection!.access_expires_at = expires
      return (cached = fresh.access_token)
    } catch (error) {
      if (error instanceof OAuthGrantError) {
        await markRevoked(ctx, connection!, error.message)
        throw new AppError("googleReconnect")
      }
      throw error
    }
  }

  return {
    userId,
    async call<T>(method: Method, path: string, options: { query?: Query; body?: unknown } = {}) {
      const url = new URL(`${apiOrigin(ctx.env)}${path}`)
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${await accessToken(attempt > 0)}`,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
        // An access token can be revoked before it expires: refresh once.
        if (response.status === 401 && attempt === 0) continue
        const text = await response.text()
        let data: unknown
        try {
          data = text ? JSON.parse(text) : undefined
        } catch {
          data = undefined
        }
        if (!response.ok) {
          const error = (data as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } })
            ?.error
          throw new GoogleError(
            response.status,
            error?.errors?.[0]?.reason ?? error?.status ?? "",
            `Google ${method} ${url.pathname} → ${response.status} ${error?.message ?? ""}`.trim(),
          )
        }
        return data as T
      }
    },
  }
}

/** Google refused our access: stop syncing until they reconnect, and tell them once. */
async function markRevoked(ctx: Ctx, connection: ConnectionRow, reason: string): Promise<void> {
  await run(
    ctx.db,
    "UPDATE google_connections SET state = 'revoked', last_error = ?, updated_at = ? WHERE user_id = ?",
    reason.slice(0, 500),
    nowIso(),
    connection.user_id,
  )
  if (connection.state !== "revoked") {
    connection.state = "revoked"
    await notify(ctx, {
      recipients: [connection.user_id],
      actorId: "",
      event: "google_reconnect",
      accountId: null,
      data: { actor: "" },
      link: "/settings",
    })
  }
}
