/**
 * The Claude connector as the signed-in person sees it: the consent screen
 * (describe, allow, deny an authorization request) and Settings → Set up MCP
 * (the connector URL and their connections).
 */
import { AppError } from "@/lib/api/core"
import type { ClaudeSetup, ConsentRequest } from "@/lib/types"
import { requireUser, type Ctx } from "@/server/context"
import { checkAuthorization, redirectWith } from "@/server/mcp/authorize"
import { connectorUrls } from "@/server/mcp/config"
import { activeGrants, issueCode, revokeGrant } from "@/server/mcp/grants"
import { myWorkspaces } from "@/server/mcp/workspaces"
import { str } from "@/server/validate"

async function checked(ctx: Ctx, params: unknown) {
  const urls = await connectorUrls(ctx)
  if (!urls) throw new AppError("connectorUnavailable")
  const result = await checkAuthorization(ctx, urls, params)
  if (!result.ok && "fatal" in result) throw new AppError(result.fatal)
  return { urls, result }
}

/** What the consent screen shows, or where to send the person straight back to. */
export async function describeAuthorization(ctx: Ctx, params: unknown): Promise<ConsentRequest> {
  await requireUser(ctx)
  const { result } = await checked(ctx, params)
  if (!result.ok) return { kind: "redirect", redirectUrl: "redirect" in result ? result.redirect : "" }
  const { client, redirectUri, scopes } = result.request
  const redirect = new URL(redirectUri)
  const local = redirect.protocol === "http:"
  return {
    kind: "consent",
    app: { name: client.name, host: client.host, local },
    redirectHost: local ? "localhost" : redirect.host,
    scopes,
  }
}

/** Allow: a one-time code for the app, on its redirect. */
export async function approveAuthorization(ctx: Ctx, params: unknown): Promise<{ redirectUrl: string }> {
  const me = await requireUser(ctx)
  const { urls, result } = await checked(ctx, params)
  if (!result.ok) return { redirectUrl: "redirect" in result ? result.redirect : "" }
  const request = result.request
  const code = await issueCode(ctx, {
    clientId: request.client.clientId,
    userId: me.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scopes: request.scopes,
    resource: request.resource,
  })
  return {
    redirectUrl: redirectWith(request.redirectUri, urls.origin, { code, state: request.state }),
  }
}

/** Deny: the app hears `access_denied`. */
export async function denyAuthorization(ctx: Ctx, params: unknown): Promise<{ redirectUrl: string }> {
  await requireUser(ctx)
  const { urls, result } = await checked(ctx, params)
  if (!result.ok) return { redirectUrl: "redirect" in result ? result.redirect : "" }
  return {
    redirectUrl: redirectWith(result.request.redirectUri, urls.origin, {
      error: "access_denied",
      error_description: "The person declined",
      state: result.request.state,
    }),
  }
}

/** Settings → Set up MCP. */
export async function getClaudeSetup(ctx: Ctx): Promise<ClaudeSetup> {
  const me = await requireUser(ctx)
  const urls = await connectorUrls(ctx)
  const [workspaces, grants] = await Promise.all([myWorkspaces(ctx, me.id), activeGrants(ctx, me.id)])
  return {
    available: urls !== null,
    // The Claude apps need https; a localhost address is for trying it with Claude Code.
    publicUrl: urls?.resource.startsWith("https://") ?? false,
    connectorUrl: urls?.resource ?? null,
    workspaces,
    connections: grants.map((g) => ({
      id: g.id,
      app: g.client_name || g.client_host,
      host: g.client_host,
      local: g.client_host === "localhost",
      scopes: g.scope.split(" "),
      createdAt: g.created_at,
      lastUsedAt: g.last_used_at,
    })),
  }
}

export async function disconnectClaude(ctx: Ctx, id: unknown): Promise<void> {
  const me = await requireUser(ctx)
  if (!(await revokeGrant(ctx, me.id, str(id, 100)))) throw new AppError("notFound")
}
