import { protectedResourceMetadata } from "@/server/mcp/endpoints"
import { preflight } from "@/server/mcp/http"

/** RFC 9728 for the `/mcp` resource: the address our 401 challenge points at. */
export const GET = protectedResourceMetadata
export const OPTIONS = preflight
