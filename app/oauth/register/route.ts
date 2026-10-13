import { registerEndpoint } from "@/server/mcp/endpoints"
import { preflight } from "@/server/mcp/http"

/** Dynamic Client Registration (RFC 7591), for clients without a metadata document. */
export const POST = registerEndpoint
export const OPTIONS = preflight
