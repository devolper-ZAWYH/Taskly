import { mcpEndpoint } from "@/server/mcp/endpoints"

/** The Claude connector's MCP endpoint (docs/plan-claude-connector.md). */
export const POST = mcpEndpoint
// Without a token these answer 401, which starts Claude's sign-in; with one, 405.
export const GET = mcpEndpoint
export const DELETE = mcpEndpoint
