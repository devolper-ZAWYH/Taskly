/**
 * Google OAuth 2.0 for a web server app: authorization code + PKCE, offline
 * access (a refresh token), and revocation on disconnect.
 */
import { oauthEndpoints, scopes, type GoogleClient } from "@/server/google/config"

export type TokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  id_token?: string
}

/** Google refused the refresh token: revoked, expired, or the app lost access. */
export class OAuthGrantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OAuthGrantError"
  }
}

export function consentUrl(
  env: CloudflareEnv,
  client: GoogleClient,
  params: {
    redirectUri: string
    state: string
    challenge: string
    loginHint?: string
    /** Also ask for Google Tasks (tasks sync is on). */
    tasks: boolean
  },
): string {
  const url = new URL(oauthEndpoints(env).auth)
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: scopes(params.tasks).join(" "),
    access_type: "offline",
    // Always show consent so Google always returns a refresh token.
    prompt: "consent",
    include_granted_scopes: "true",
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  }).toString()
  return url.toString()
}

async function tokenRequest(
  env: CloudflareEnv,
  client: GoogleClient,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(oauthEndpoints(env).token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...body,
    }),
  })
  const data = (await response.json().catch(() => ({}))) as TokenResponse & {
    error?: string
    error_description?: string
  }
  if (!response.ok || data.error) {
    const message = `${data.error ?? response.status} ${data.error_description ?? ""}`.trim()
    if (data.error === "invalid_grant") throw new OAuthGrantError(message)
    throw new Error(`Google token request failed: ${message}`)
  }
  return data
}

export function exchangeCode(
  env: CloudflareEnv,
  client: GoogleClient,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenResponse> {
  return tokenRequest(env, client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
}

export function refreshAccessToken(
  env: CloudflareEnv,
  client: GoogleClient,
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenRequest(env, client, { grant_type: "refresh_token", refresh_token: refreshToken })
}

/** Best effort: a token Google already dropped is fine. */
export async function revokeToken(env: CloudflareEnv, token: string): Promise<void> {
  await fetch(oauthEndpoints(env).revoke, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined)
}

/**
 * The account behind an ID token. It came straight from Google's token
 * endpoint over TLS in exchange for our client secret, so it isn't re-verified.
 */
export function idTokenClaims(idToken: string | undefined): { sub: string; email: string } | null {
  const payload = idToken?.split(".")[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub?: string
      email?: string
    }
    return claims.sub && claims.email ? { sub: claims.sub, email: claims.email } : null
  } catch {
    return null
  }
}
