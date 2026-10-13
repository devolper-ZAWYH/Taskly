/**
 * Checking an authorization request (`/oauth/authorize?...`). Problems with
 * the client or its redirect are shown on Taskly's page, because we must not
 * send anyone to an address we can't trust; every other problem goes back to
 * the app as an OAuth error on its redirect (RFC 6749 §4.1.2.1).
 */
import type { ErrorCode } from "@/lib/api/core"
import type { Ctx } from "@/server/context"
import { resolveClient, type OAuthClient } from "@/server/mcp/clients"
import type { ConnectorUrls } from "@/server/mcp/config"
import {
  grantedScopes,
  redirectAllowed,
  redirectRegistered,
  type Scope,
} from "@/server/mcp/oauth-rules"

export type AuthorizeRequest = {
  client: OAuthClient
  redirectUri: string
  codeChallenge: string
  scopes: Scope[]
  resource: string
  state: string | null
}

export type CheckedAuthorization =
  | { ok: true; request: AuthorizeRequest }
  /** Shown on Taskly's page; the app's redirect can't be trusted. */
  | { ok: false; fatal: ErrorCode }
  /** Sent back to the app. */
  | { ok: false; redirect: string }

const MAX_PARAM = 2048

/** The query parameters as plain strings (anything else reads as missing). */
export function authorizeParams(raw: unknown): Record<string, string> {
  const params: Record<string, string> = {}
  if (typeof raw !== "object" || raw === null) return params
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length <= MAX_PARAM) params[key] = value
  }
  return params
}

/** `redirectUri` with the response appended, plus `iss` (RFC 9207) so the app knows who answered. */
export function redirectWith(
  redirectUri: string,
  issuer: string,
  values: Record<string, string | null>,
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) url.searchParams.set(key, value)
  }
  url.searchParams.set("iss", issuer)
  return url.toString()
}

export async function checkAuthorization(
  ctx: Ctx,
  urls: ConnectorUrls,
  raw: unknown,
): Promise<CheckedAuthorization> {
  const p = authorizeParams(raw)
  const client = p.client_id ? await resolveClient(ctx, p.client_id) : null
  if (!client) return { ok: false, fatal: "oauthInvalidClient" }

  // No redirect_uri: only acceptable when the client registered exactly one.
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "")
  if (!redirectUri || !redirectRegistered(client.redirectUris, redirectUri) || !redirectAllowed(redirectUri)) {
    return { ok: false, fatal: "oauthInvalidRedirect" }
  }

  const state = p.state ?? null
  const fail = (error: string, description: string): CheckedAuthorization => ({
    ok: false,
    redirect: redirectWith(redirectUri, urls.origin, { error, error_description: description, state }),
  })

  if (p.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported")
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9\-._~]{43,128}$/.test(p.code_challenge ?? "")) {
    return fail("invalid_request", "PKCE with S256 is required")
  }
  const scopes = grantedScopes(p.scope)
  if (!scopes) return fail("invalid_scope", "Supported scopes: taskly.read taskly.write")
  // RFC 8707: tokens are only ever for this MCP endpoint.
  const resource = p.resource ?? urls.resource
  if (resource.replace(/\/$/, "") !== urls.resource) {
    return fail("invalid_target", `This server only issues tokens for ${urls.resource}`)
  }

  return {
    ok: true,
    request: { client, redirectUri, codeChallenge: p.code_challenge!, scopes, resource: urls.resource, state },
  }
}
