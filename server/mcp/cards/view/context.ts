import type { App } from "@modelcontextprotocol/ext-apps"
import type { CardView } from "@/server/mcp/cards/types"
import type { Formats } from "./format"
import type { Strings } from "./strings"

/** A tool result, as the card receives it. */
export type ToolResult = Awaited<ReturnType<App["callServerTool"]>>

/** What every card gets: its data, words, and ways to talk to Taskly and to Claude. */
export type CardContext<T> = {
  data: T
  view: CardView
  /** The arguments Claude called the tool with. */
  input: Record<string, unknown>
  t: Strings
  f: Formats
  /** Draw the card again after its state changed. */
  redraw: () => void
  /** Call a Taskly tool (through Claude, as the same person). */
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  /** Tell Claude what happened on the card, for its next turn. */
  tellClaude: (text: string) => Promise<void>
  /** Send a message in the chat as the person. False if the app refused it. */
  say: (text: string) => Promise<boolean>
  open: (url: string) => void
  /** A failed result in the person's words. */
  problem: (result: ToolResult | null) => string
}

/** Draws the card's current state. */
export type Draw = () => Node
