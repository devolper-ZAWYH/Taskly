import { tokenEndpoint } from "@/server/mcp/endpoints"
import { preflight } from "@/server/mcp/http"

export const POST = tokenEndpoint
export const OPTIONS = preflight
