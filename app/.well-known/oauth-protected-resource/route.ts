import { protectedResourceMetadata } from "@/server/mcp/endpoints"
import { preflight } from "@/server/mcp/http"

/** RFC 9728 at the root location (clients try `/mcp` first, then this). */
export const GET = protectedResourceMetadata
export const OPTIONS = preflight
