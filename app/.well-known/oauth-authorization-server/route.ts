import { authorizationServerMetadata } from "@/server/mcp/endpoints"
import { preflight } from "@/server/mcp/http"

/** RFC 8414: Taskly's OAuth server for the Claude connector. */
export const GET = authorizationServerMetadata
export const OPTIONS = preflight
