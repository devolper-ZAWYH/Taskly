/**
 * Pieces every connector tool shares: argument schemas, result shapes, links
 * into Taskly, and running a tool in the chosen workspace.
 */
import type { CallToolResult } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { AppError } from "@/lib/api/core"
import type { Task } from "@/lib/types"
import en from "@/messages/en"
import type { Ctx } from "@/server/context"
import type { CardKind, CardView } from "@/server/mcp/cards/types"
import type { ConnectorUrls } from "@/server/mcp/config"
import type { Caller } from "@/server/mcp/grants"
import { pickWorkspace, type Workspace } from "@/server/mcp/workspaces"
import { listPeople } from "@/server/services/members"

export type ToolEnv = {
  ctx: Ctx
  caller: Caller
  urls: ConnectorUrls
  workspaces: Workspace[]
  /** A photo URL a card can load, from an app avatar path (server/mcp/photos.ts). */
  photo: (avatarPath: string | null) => Promise<string | null>
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** Creates something new; nothing existing is changed or removed. */
export const ADDITIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

export const WORKSPACE = z
  .string()
  .max(200)
  .optional()
  .describe(
    "Workspace id or name from list_workspaces. Required when the person belongs to several workspaces.",
  )
export const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
export const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)")

// ---- Results ---------------------------------------------------------------------

export function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n${JSON.stringify(data)}` }],
    structuredContent: data,
  }
}

/** A result shown as a card too. `view` goes to the card only, not into the text Claude reads. */
export function okCard(summary: string, data: object, view: CardView): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}
${JSON.stringify(data)}` }],
    structuredContent: { ...data, view },
  }
}

/** The card's own details: language, workspace, and photos of the people it shows. */
export async function cardView(
  env: ToolEnv,
  workspace: Workspace,
  card: CardKind,
  people: { id: string; avatarUrl: string | null }[] = [],
): Promise<CardView> {
  const photos: Record<string, string> = {}
  for (const person of people) {
    const url = await env.photo(person.avatarUrl)
    if (url) photos[person.id] = url
  }
  return { card, locale: env.ctx.user?.locale === "ar" ? "ar" : "en", workspaceId: workspace.id, photos }
}

/** An error for Claude to explain. `code` lets a card say it in the person's language. */
export function fail(message: string, code?: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(code ? { structuredContent: { error: code } } : {}),
  }
}

/** Run a tool in the chosen workspace; Taskly's own errors become readable tool errors. */
export async function inWorkspace(
  env: ToolEnv,
  arg: string | undefined,
  work: (workspace: Workspace) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const workspace = pickWorkspace(env.workspaces, arg)
  if (typeof workspace === "string") {
    return fail(workspace, workspace.startsWith("workspace_required") ? "workspace_required" : "workspace")
  }
  try {
    return await work(workspace)
  } catch (error) {
    if (error instanceof AppError) {
      return fail((en.errors as Record<string, string>)[error.code] ?? error.code, error.code)
    }
    throw error
  }
}

// ---- Shapes ------------------------------------------------------------------------

export const links = (urls: ConnectorUrls) => ({
  task: (accountId: string, id: string) => `${urls.origin}/w/${accountId}/tasks?task=${id}`,
  meeting: (accountId: string, id: string, date: string) =>
    `${urls.origin}/w/${accountId}/calendar?view=week&date=${date}&meeting=${id}`,
  minutes: (accountId: string, id: string) => `${urls.origin}/w/${accountId}/minutes?minutes=${id}`,
})

export async function namesIn(ctx: Ctx, accountId: string) {
  const people = await listPeople(ctx, accountId)
  const byId = new Map(people.map((p) => [p.id, p.name]))
  return (id: string | null) => (id ? (byId.get(id) ?? "Former member") : null)
}

const CLOSED = ["completed", "cancelled"]
export const dueKey = (task: Task) => `${task.dueDate || "9999"}T${task.dueTime || "23:59"}`

export function taskSummary(
  task: Task,
  nameOf: (id: string | null) => string | null,
  today: string,
  link: string,
) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    private: task.private,
    due: task.dueDate ? `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : null,
    overdue: Boolean(task.dueDate) && task.dueDate < today && !CLOSED.includes(task.status),
    assignees: task.assigneeIds.map(nameOf),
    meetingId: task.meetingId,
    link,
  }
}

export function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** "Thursday 22 October 2026": what reviews say out loud, so a misheard date is caught. */
export function longDate(ymd: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ymd}T00:00:00Z`))
}
