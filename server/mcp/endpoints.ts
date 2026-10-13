/**
 * The connector's HTTP endpoints, called from thin route files under `app/`:
 * the MCP endpoint itself, the two discovery documents, and the OAuth token,
 * registration and revocation endpoints. The sign-in and consent screen is a
 * page (app/oauth/authorize).
 */
import { createMcpHandler, originValidationResponse, type AuthInfo } from "@modelcontextprotocol/server"
import type { Ctx } from "@/server/context"
import { first, toUser, type UserRow } from "@/server/db"
import { registerClient, resolveClient, touchClient } from "@/server/mcp/clients"
import { connectorUrls, type ConnectorUrls } from "@/server/mcp/config"
import {
  createGrant,
  issueTokens,
  redeemCode,
  refreshTokens,
  revokeByToken,
  verifyAccessToken,
} from "@/server/mcp/grants"
import { formFields, json, oauthError, CORS } from "@/server/mcp/http"
import { pkceMatches, SCOPES } from "@/server/mcp/oauth-rules"
import { buildServer } from "@/server/mcp/server"
import { requestContext } from "@/server/request"

const notFound = () => new Response("Not found", { status: 404 })

async function setup(request: Request): Promise<{ ctx: Ctx; urls: ConnectorUrls } | null> {
  const ctx = await requestContext(request)
  const urls = await connectorUrls(ctx)
  return urls ? { ctx, urls } : null
}

// ---- Discovery ---------------------------------------------------------------------

/** RFC 9728: what this MCP endpoint is and who issues its tokens. */
export async function protectedResourceMetadata(request: Request): Promise<Response> {
  const found = await setup(request)
  if (!found) return notFound()
  const { urls } = found
  return json({
    resource: urls.resource,
    authorization_servers: [urls.origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Taskly",
    resource_documentation: `${urls.origin}/settings#claude`,
  })
}

/**
 * RFC 8414. Claude uses its Client ID Metadata Document only when we say we
 * accept those *and* public clients (`none`); otherwise it falls back to
 * registering a new client on every connection.
 */
export async function authorizationServerMetadata(request: Request): Promise<Response> {
  const found = await setup(request)
  if (!found) return notFound()
  const { urls } = found
  return json({
    issuer: urls.origin,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    registration_endpoint: urls.register,
    revocation_endpoint: urls.revoke,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${urls.origin}/settings#claude`,
  })
}

// ---- OAuth -----------------------------------------------------------------------------

/** Public clients send only client_id; a few put it in HTTP Basic instead. */
function clientIdOf(request: Request, form: URLSearchParams): string {
  const fromForm = form.get("client_id")
  if (fromForm) return fromForm
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  if (!basic) return ""
  try {
    return decodeURIComponent(atob(basic).split(":")[0] ?? "")
  } catch {
    return ""
  }
}

export async function tokenEndpoint(request: Request): Promise<Response> {
  const found = await setup(request)
  if (!found) return notFound()
  const { ctx } = found
  const form = await formFields(request)
  const clientId = clientIdOf(request, form)
  if (!clientId) return oauthError("invalid_client", "client_id is required", 401)

  const grantType = form.get("grant_type")
  if (grantType === "authorization_code") {
    const code = form.get("code")
    const verifier = form.get("code_verifier")
    if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required")
    const row = await redeemCode(ctx, code)
    if (!row || row.client_id !== clientId) {
      return oauthError("invalid_grant", "The code is invalid, used or expired")
    }
    const redirect = form.get("redirect_uri")
    if (redirect && redirect !== row.redirect_uri) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request")
    }
    if (!(await pkceMatches(verifier, row.code_challenge))) {
      return oauthError("invalid_grant", "PKCE verification failed")
    }
    const resource = form.get("resource")
    if (resource && resource.replace(/\/$/, "") !== row.resource) {
      return oauthError("invalid_target", `Tokens are only issued for ${row.resource}`)
    }
    const client = await resolveClient(ctx, clientId)
    if (!client) return oauthError("invalid_client", "Unknown client", 401)
    const grantId = await createGrant(ctx, {
      userId: row.user_id,
      client,
      scope: row.scope,
      resource: row.resource,
    })
    await touchClient(ctx, clientId)
    return json(await issueTokens(ctx, grantId, row.scope))
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token")
    if (!refreshToken) return oauthError("invalid_request", "refresh_token is required")
    const result = await refreshTokens(ctx, refreshToken, clientId, form.get("scope"))
    if (result === "invalid_grant") {
      return oauthError("invalid_grant", "The refresh token is invalid, used, expired or revoked")
    }
    if (result === "invalid_scope") return oauthError("invalid_scope", "Scope exceeds the grant")
    await touchClient(ctx, clientId)
    return json(result)
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token")
}

export async function registerEndpoint(request: Request): Promise<Response> {
  const found = await setup(request)
  if (!found) return notFound()
  const body = await request.json().catch(() => null)
  const result = await registerClient(found.ctx, body)
  return result.ok ? json(result.body, 201) : oauthError(result.error, result.description)
}

/** RFC 7009: always 200, whether or not the token existed. */
export async function revokeEndpoint(request: Request): Promise<Response> {
  const found = await setup(request)
  if (!found) return notFound()
  const token = (await formFields(request)).get("token")
  if (token) await revokeByToken(found.ctx, token)
  return json({})
}

// ---- MCP -------------------------------------------------------------------------------

/**
 * 401 with the discovery pointer: this is what makes Claude start signing in.
 * The scopes are listed too, because Claude asks for what the challenge names.
 */
function challenge(urls: ConnectorUrls, invalid: boolean): Response {
  const parts = [
    ...(invalid ? ['error="invalid_token"', 'error_description="The access token is invalid or has expired"'] : []),
    `resource_metadata="${urls.resourceMetadata}"`,
    `scope="${SCOPES.join(" ")}"`,
  ]
  return Response.json(
    { error: invalid ? "invalid_token" : "unauthorized" },
    { status: 401, headers: { "www-authenticate": `Bearer ${parts.join(", ")}`, ...CORS } },
  )
}

const bearer = (request: Request) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null

/**
 * POST /mcp. Checks the Origin (browsers only; Claude's servers send none),
 * then the access token, then serves one stateless MCP exchange as that
 * person — without operator powers: the connector acts only where they are a
 * member.
 */
export async function mcpEndpoint(request: Request): Promise<Response> {
  const found = await setup(request)
  if (!found) return notFound()
  const { ctx: base, urls } = found
  const rejected = originValidationResponse(request, [new URL(urls.origin).hostname, "claude.ai", "claude.com"])
  if (rejected) return rejected

  const token = bearer(request)
  const caller = token ? await verifyAccessToken(base, token, urls.resource) : null
  if (!token || !caller) return challenge(urls, token !== null)
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } })
  }

  const row = await first<UserRow>(base.db, "SELECT * FROM users WHERE id = ?", caller.userId)
  if (!row) return challenge(urls, true)
  const ctx: Ctx = { ...base, token: null, user: { ...toUser(row), isOperator: false } }
  const authInfo: AuthInfo = {
    token,
    clientId: caller.clientId,
    scopes: caller.scopes,
    expiresAt: caller.expiresAt,
    resource: new URL(urls.resource),
    resourceMetadataUrl: urls.resourceMetadata,
  }
  const handler = createMcpHandler(() => buildServer(ctx, caller, urls), {
    responseMode: "json",
    onerror: (error) => console.error("mcp request failed", error),
  })
  return handler.fetch(request, { authInfo })
}
