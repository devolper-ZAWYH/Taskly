import { revokeEndpoint } from "@/server/mcp/endpoints"
import { preflight } from "@/server/mcp/http"

/** RFC 7009 token revocation. */
export const POST = revokeEndpoint
export const OPTIONS = preflight
