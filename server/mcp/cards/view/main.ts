/**
 * The card's entry point. Claude loads this page next to a tool call, sends
 * the call's arguments and result, and relays the card's own tool calls and
 * messages (MCP Apps). The page picks the card from the result's `view`.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps"
import type { CardData, CardView } from "@/server/mcp/cards/types"
import type { CardContext, Draw, ToolResult } from "./context"
import { h } from "./dom"
import { formats } from "./format"
import { myDayCard } from "./my-day"
import { outcomeCard } from "./outcome"
import { meetingPicker, peoplePicker } from "./pickers"
import { reviewCard } from "./review"
import { stringsFor, type Strings } from "./strings"

const root = document.getElementById("root")!
const app = new App({ name: "Taskly", version: "1.0.0" }, { availableDisplayModes: ["inline"] })

let input: Record<string, unknown> = {}
let draw: Draw | null = null
/** Until a result says otherwise, words follow the page's language. */
let strings: Strings = stringsFor(document.documentElement.lang === "ar" ? "ar" : "en")

function redraw() {
  const node = draw ? draw() : skeleton()
  // Cards built once return the same node; leaving it in place keeps focus.
  if (root.firstChild !== node || root.childNodes.length !== 1) root.replaceChildren(node)
}

function skeleton(): Node {
  return h(
    "div",
    { class: "card skeleton", "aria-busy": "true" },
    h("span", { class: "bone short" }),
    h("span", { class: "bone title" }),
    h("span", { class: "bone" }),
    h("span", { class: "bone" }),
  )
}

function message(text: string): Draw {
  const node = h("p", { class: "card status muted", text })
  return () => node
}

function setLanguage(locale: "en" | "ar") {
  strings = stringsFor(locale)
  document.documentElement.lang = locale
  document.documentElement.dir = locale === "ar" ? "rtl" : "ltr"
}

/** A failed result in the person's words (tool errors carry a code). */
function problem(result: ToolResult | null): string {
  const code = (result?.structuredContent as { error?: string } | undefined)?.error
  const text = result?.content?.map((part) => (part.type === "text" ? part.text : "")).join(" ") ?? ""
  if (code && code in strings.errors) return strings.errors[code as keyof Strings["errors"]]
  if (/insufficient.?scope|taskly\.write/i.test(text)) return strings.errors.write_scope
  return strings.errors.generic
}

function context<T>(data: T, view: CardView): CardContext<T> {
  return {
    data,
    view,
    input,
    t: strings,
    f: formats(view.locale),
    redraw,
    call: (name, args) => app.callServerTool({ name, arguments: args }),
    tellClaude: async (text) => {
      await app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined)
    },
    say: async (text) => {
      const sent = await app
        .sendMessage({ role: "user", content: [{ type: "text", text }] })
        .catch(() => ({ isError: true }))
      return !sent.isError
    },
    open: (url) => {
      void app.openLink({ url }).catch(() => undefined)
    },
    problem,
  }
}

function show(result: ToolResult) {
  const data = result.structuredContent as CardData | undefined
  const view = data?.view
  if (view) setLanguage(view.locale)
  if (result.isError || !data || !view) {
    draw = message(result.isError ? problem(result) : strings.errors.nothing)
    return redraw()
  }
  switch (view.card) {
    case "delegation":
    case "meeting":
      draw = reviewCard(context(data as never, view), view.card)
      break
    case "outcome":
      draw = outcomeCard(context(data as never, view))
      break
    case "my_day":
      draw = myDayCard(context(data as never, view))
      break
    case "choose_meeting":
      draw = meetingPicker(context(data as never, view))
      break
    case "choose_people":
      draw = peoplePicker(context(data as never, view), String(input.purpose ?? "other"))
      break
    default:
      draw = message(strings.errors.nothing)
  }
  redraw()
}

function applyHost(host: McpUiHostContext | undefined) {
  if (!host) return
  if (host.theme) applyDocumentTheme(host.theme)
  if (host.styles?.variables) applyHostStyleVariables(host.styles.variables)
  if (host.styles?.css?.fonts) applyHostFonts(host.styles.css.fonts)
  const inset = host.safeAreaInsets
  if (inset) {
    const style = document.documentElement.style
    style.setProperty("--inset-top", `${inset.top}px`)
    style.setProperty("--inset-right", `${inset.right}px`)
    style.setProperty("--inset-bottom", `${inset.bottom}px`)
    style.setProperty("--inset-left", `${inset.left}px`)
  }
}

// Handlers first: the host sends the tool's arguments and result right after connecting.
app.ontoolinput = (params) => {
  input = (params.arguments as Record<string, unknown> | undefined) ?? {}
}
app.ontoolresult = (result) => show(result as ToolResult)
app.ontoolcancelled = () => {
  draw = message(strings.errors.cancelled)
  redraw()
}
app.onhostcontextchanged = (changed) => applyHost(changed)
app.onteardown = async () => ({})

redraw()
app
  .connect()
  .then(() => applyHost(app.getHostContext()))
  .catch((error: unknown) => console.error("Taskly card couldn't connect", error))
