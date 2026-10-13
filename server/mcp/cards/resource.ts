/**
 * The interactive card (phase 3 of docs/plan-claude-connector.md): one small
 * web page, built from ./view by `yarn cards`, that Claude shows under the
 * tool calls that name it. It reads the tool's result and talks back only
 * through Claude (MCP Apps), so it needs no sign-in of its own.
 */
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server"
import { CARD_HTML, CARD_VERSION } from "@/server/mcp/cards/card-html.generated"
import type { ConnectorUrls } from "@/server/mcp/config"

/** Versioned, so Claude never shows a stale copy after an update. */
export const CARD_URI = `ui://taskly/card-${CARD_VERSION}.html`

/** A version's page never changes and holds nothing personal. */
const SAME_FOR_EVERYONE = { ttlMs: 24 * 60 * 60 * 1000, cacheScope: "public" } as const

/** `_meta` for a tool whose results show the card. */
export const CARD_META = { ui: { resourceUri: CARD_URI } }

export function registerCardResource(server: McpServer, urls: ConnectorUrls): void {
  const ui = {
    // Profile photos come from Taskly; Claude's own font (Anthropic Sans) from
    // its asset host. Nothing else is fetched.
    csp: { resourceDomains: [urls.origin, "https://assets.claude.ai"] },
    // Part of the conversation rather than a box inside it, as Claude recommends.
    prefersBorder: false,
  }
  const read = (uri: string) => ({
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: CARD_HTML, _meta: { ui } }],
  })
  // What ext-apps' registerAppResource does, plus a cache hint it doesn't pass on.
  server.registerResource(
    "Taskly card",
    CARD_URI,
    {
      description: "Pickers, reviews and your day, shown in the conversation.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui },
      cacheHint: SAME_FOR_EVERYONE,
    },
    async () => read(CARD_URI),
  )
  // Cards in earlier conversations ask for the version they were shown with;
  // the current one reads the same results.
  server.registerResource(
    "Taskly card (earlier versions)",
    new ResourceTemplate("ui://taskly/card-{version}.html", { list: undefined }),
    { mimeType: RESOURCE_MIME_TYPE, cacheHint: SAME_FOR_EVERYONE },
    async (uri) => read(uri.href),
  )
}
