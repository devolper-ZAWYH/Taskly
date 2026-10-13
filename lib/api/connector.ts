import { rpc } from "@/lib/api/rpc"
import type { ClaudeSetup, ConsentRequest } from "@/lib/types"

/** The query string of /oauth/authorize, as sent by the app asking for access. */
export type AuthorizeParams = Record<string, string>

/** What the consent screen shows, or where to send the person straight back to. */
export const describeAuthorization = (params: AuthorizeParams): Promise<ConsentRequest> =>
  rpc("describeAuthorization", params)

/** Allow: returns the app's redirect, carrying a one-time code. */
export const approveAuthorization = (params: AuthorizeParams): Promise<{ redirectUrl: string }> =>
  rpc("approveAuthorization", params)

/** Deny: returns the app's redirect, carrying `access_denied`. */
export const denyAuthorization = (params: AuthorizeParams): Promise<{ redirectUrl: string }> =>
  rpc("denyAuthorization", params)

export const getClaudeSetup = (): Promise<ClaudeSetup> => rpc("getClaudeSetup")

export const disconnectClaude = (id: string): Promise<void> => rpc("disconnectClaude", id)
