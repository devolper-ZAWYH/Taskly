/**
 * Tools whose main purpose is a card (phase 3): your day, and pickers for a
 * meeting or for people. Each one still answers in words, for voice, Claude
 * Code and any app that can't show cards: Claude then asks the question
 * itself, as in phase 2.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server"
import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import type { Task } from "@/lib/types"
import { all } from "@/server/db"
import { CARD_META } from "@/server/mcp/cards/resource"
import type { DayTask, MeetingChoices, MyDay, PeopleChoices } from "@/server/mcp/cards/types"
import { matchPerson } from "@/server/mcp/match"
import {
  cardView,
  DATE,
  dueKey,
  fail,
  inWorkspace,
  links,
  longDate,
  okCard,
  READ_ONLY,
  shiftDate,
  WORKSPACE,
  type ToolEnv,
} from "@/server/mcp/shared"
import { workspaceClock } from "@/server/mcp/workspaces"
import { listMeetings } from "@/server/services/meetings"
import { listPeople } from "@/server/services/members"
import { listTasks } from "@/server/services/tasks"

/** Enough to choose from without a long scroll; the rest is in Taskly. */
const DAY_TASKS = 8
const MEETING_CHOICES = 20

export function registerCardTools(server: McpServer, env: ToolEnv): void {
  const { ctx, caller, urls } = env
  const link = links(urls)

  registerAppTool(
    server,
    "my_day",
    {
      title: "Your day",
      description:
        'The person\'s day in a workspace: their meetings today, and their tasks due today or overdue. Use it for "what\'s on today?", "my day", "what do I have to do today?". In the Claude apps it is a card where they can tick tasks done.',
      inputSchema: z.object({ workspace: WORKSPACE }),
      annotations: READ_ONLY,
      _meta: CARD_META,
    },
    async ({ workspace }) =>
      inWorkspace(env, workspace, async (w) => {
        const { today, timeZone } = await workspaceClock(ctx, w.id, caller.userId)
        const query = (scope: "mine" | "assigned", due: "overdue" | "today") =>
          listTasks(ctx, w.id, { scope, search: "", page: 1, pageSize: 50, filters: { due, today } })
        const [meetings, ...lists] = await Promise.all([
          listMeetings(ctx, w.id, { from: today, to: today }),
          query("mine", "overdue"),
          query("assigned", "overdue"),
          query("mine", "today"),
          query("assigned", "today"),
        ])
        const due = lists
          .flatMap((list) => list.items)
          .sort((a, b) => dueKey(a).localeCompare(dueKey(b)))
        const total = lists.reduce((sum, list) => sum + list.total, 0)
        const tasks: DayTask[] = due.slice(0, DAY_TASKS).map((t: Task) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          due: t.dueDate ? `${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ""}` : null,
          overdue: t.dueDate < today,
          link: link.task(w.id, t.id),
        }))
        const mine = meetings.filter(
          (m) => m.organizerId === caller.userId || m.attendeeIds.includes(caller.userId),
        )
        const day: MyDay = {
          workspace: w.name,
          today,
          timeZone,
          meetings: mine.map((m) => ({
            id: m.id,
            title: m.title,
            start: m.startTime,
            end: m.endTime,
            location: m.location || null,
            link: link.meeting(w.id, m.id, m.date),
          })),
          tasks,
          moreTasks: Math.max(0, total - tasks.length),
          tasksLink: `${urls.origin}/w/${w.id}/tasks`,
          calendarLink: `${urls.origin}/w/${w.id}/calendar?view=week&date=${today}`,
        }
        const overdue = due.filter((t) => t.dueDate < today).length
        const summary =
          `${longDate(today)} in ${w.name}: ${mine.length} meeting(s); ` +
          `${total} task(s) due today or overdue${overdue ? ` (${overdue} overdue)` : ""}.`
        return okCard(summary, day, await cardView(env, w, "my_day"))
      }),
  )

  registerAppTool(
    server,
    "choose_meeting",
    {
      title: "Choose a meeting",
      description:
        "Let the person pick a meeting, e.g. the one to write minutes for. Lists the meetings they can see between two dates, most recent first (default: the last two weeks up to today). In the Claude apps they pick on a card and their choice arrives as their next message; otherwise ask them which one from the list.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        from: DATE.optional(),
        to: DATE.optional(),
        search: z.string().max(200).optional().describe("Words in the title, agenda or location"),
      }),
      annotations: READ_ONLY,
      _meta: CARD_META,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        const { today } = await workspaceClock(ctx, w.id, caller.userId)
        const to = args.to ?? today
        const from = args.from ?? shiftDate(to, -14)
        if (to < from) return fail("`to` must be on or after `from`.")
        if (shiftDate(from, 92) < to) return fail("Search at most 92 days at a time.")
        const words = args.search?.trim().toLowerCase()
        const found = (await listMeetings(ctx, w.id, { from, to }))
          .filter(
            (m) =>
              !words ||
              [m.title, m.notes, m.location].some((text) => text.toLowerCase().includes(words)),
          )
          .reverse()
        const shown = found.slice(0, MEETING_CHOICES)
        const withMinutes = new Set(
          (
            await all<{ meeting_id: string }>(
              ctx.db,
              `SELECT meeting_id FROM meeting_minutes
               WHERE author_id = ? AND account_id = ? AND meeting_id IN (SELECT value FROM json_each(?))`,
              caller.userId,
              w.id,
              JSON.stringify(shown.map((m) => m.id)),
            )
          ).map((row) => row.meeting_id),
        )
        const choices: MeetingChoices = {
          workspace: w.name,
          today,
          meetings: shown.map((m) => ({
            id: m.id,
            title: m.title,
            date: m.date,
            start: m.startTime,
            end: m.endTime,
            location: m.location || null,
            attendees: m.attendeeIds.length,
            hasMyMinutes: withMinutes.has(m.id),
          })),
          total: found.length,
          next:
            found.length === 0
              ? "No meetings in that range. Ask the person when it was, then try another range."
              : "Wait for the person's choice: on the card it arrives as their next message, with the meeting's id. Otherwise ask which one they mean.",
        }
        return okCard(
          `${found.length} meeting(s) in ${w.name} from ${from} to ${to}, most recent first; showing ${shown.length}.`,
          choices,
          await cardView(env, w, "choose_meeting"),
        )
      }),
  )

  registerAppTool(
    server,
    "choose_people",
    {
      title: "Choose people",
      description:
        "Let the person pick people from the workspace, e.g. a meeting's attendees, who a task is for, or who may read minutes, when they haven't said or asked to choose. In the Claude apps they tick names on a card and their choice arrives as their next message; otherwise ask them (list_people has everyone).",
      inputSchema: z.object({
        workspace: WORKSPACE,
        purpose: z.enum(["attendees", "assignees", "readers", "other"]).describe("What they are choosing people for"),
        multiple: z.boolean().optional().describe("Allow several people (default true)"),
        selected: z
          .array(z.string().min(1).max(200))
          .max(50)
          .optional()
          .describe("Names or ids already mentioned, ticked to start with"),
      }),
      annotations: READ_ONLY,
      _meta: CARD_META,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        const members = (await listPeople(ctx, w.id)).filter((m) => m.active)
        // You organise the meeting and can always read your own minutes.
        const withoutMe = args.purpose === "attendees" || args.purpose === "readers"
        const people = members.filter((m) => !(withoutMe && m.id === caller.userId))
        const refs = people.map((m) => ({ id: m.id, name: m.name, email: m.email }))
        const selected = (args.selected ?? []).flatMap((query) => {
          const match = matchPerson(query, refs)
          return match.kind === "found" && match.quality !== "similar" ? [match.person.id] : []
        })
        const choices: PeopleChoices = {
          workspace: w.name,
          multiple: args.multiple ?? true,
          people: people.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role })),
          selected: [...new Set(selected)],
          next: "Wait for the person's choice: on the card it arrives as their next message, with ids. Otherwise ask them who.",
        }
        return okCard(
          `${people.length} people in ${w.name} to choose from.`,
          choices,
          await cardView(env, w, "choose_people", people),
        )
      }),
  )
}
