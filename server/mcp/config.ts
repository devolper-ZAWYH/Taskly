/**
 * Where Taskly's Claude connector lives. Everything follows from the App
 * address (Platform → Settings): the MCP endpoint is `<origin>/mcp`, and
 * Taskly itself is the authorization server, with the origin as its issuer.
 */
import type { Ctx } from "@/server/context"
import { appOrigin } from "@/server/settings"

export type ConnectorUrls = {
  /** Also the OAuth issuer. */
  origin: string
  /** The MCP endpoint, and the audience every token is bound to (RFC 8707 `resource`). */
  resource: string
  /** RFC 9728 metadata for `resource` (the path-aware location). */
  resourceMetadata: string
  authorize: string
  token: string
  register: string
  revoke: string
}

/** https, or http on localhost for development (Claude Code accepts that; the Claude apps don't). */
function usable(origin: string): boolean {
  return origin.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

/** The connector's addresses, or null when this Taskly has no usable App address. */
export async function connectorUrls(ctx: Ctx): Promise<ConnectorUrls | null> {
  const origin = await appOrigin(ctx)
  if (!usable(origin)) return null
  return {
    origin,
    resource: `${origin}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
    authorize: `${origin}/oauth/authorize`,
    token: `${origin}/oauth/token`,
    register: `${origin}/oauth/register`,
    revoke: `${origin}/oauth/revoke`,
  }
}
