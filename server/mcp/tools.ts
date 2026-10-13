/**
 * The read-only tools (phase 1 of docs/plan-claude-connector.md). Each one
 * calls the same service functions as the app, as the signed-in person, so
 * what Claude can see is exactly what they can see in Taskly: their private
 * tasks, members' limits, minutes sharing.
 */
import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import type { MeetingMinutes, Task, TaskFilters, TaskScope } from "@/lib/types"
import { all } from "@/server/db"
import {
  DATE,
  dueKey,
  fail,
  inWorkspace,
  links,
  namesIn,
  ok,
  READ_ONLY,
  shiftDate,
  taskSummary,
  WORKSPACE,
  type ToolEnv,
} from "@/server/mcp/shared"
import { workspaceClock } from "@/server/mcp/workspaces"
import { getMeeting, listMeetings, listMeetingTasks } from "@/server/services/meetings"
import { listPeople } from "@/server/services/members"
import { getMinutes, listMeetingMinutes } from "@/server/services/minutes"
import { getTask, listTasks } from "@/server/services/tasks"
import { PRIORITIES, STATUSES } from "@/server/validate"

// Results stay well under Claude's ~150,000-character limit.
const MAX_BODY = 20_000

export function minutesShape(
  minutes: MeetingMinutes,
  nameOf: (id: string | null) => string | null,
  me: string,
  link: string,
) {
  return {
    id: minutes.id,
    meeting: { id: minutes.meetingId, title: minutes.meetingTitle, date: minutes.meetingDate },
    author: nameOf(minutes.authorId),
    mine: minutes.authorId === me,
    visibility: minutes.visibility,
    sharedWith: minutes.sharedWithIds.map(nameOf),
    updatedAt: minutes.updatedAt,
    body:
      minutes.body.length > MAX_BODY
        ? `${minutes.body.slice(0, MAX_BODY)}\n[… shortened; open the link for the rest]`
        : minutes.body,
    link,
  }
}

// ---- Tools -------------------------------------------------------------------------

export function registerReadTools(server: McpServer, env: ToolEnv): void {
  const { ctx, caller, urls } = env
  const link = links(urls)

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "The person's Taskly workspaces with their role in each (administrator or member) and each workspace's current date and time zone. Use it at the start of a conversation to choose the workspace.",
      annotations: READ_ONLY,
    },
    async () => {
      const workspaces = await Promise.all(
        env.workspaces.map(async (w) => ({ ...w, ...(await workspaceClock(ctx, w.id, caller.userId)) })),
      )
      const note =
        workspaces.length > 1
          ? "Several workspaces: ask which one to use for this conversation, then pass it as `workspace` on every call."
          : "One workspace: it is used automatically."
      return ok(note, { workspaces })
    },
  )

  server.registerTool(
    "list_people",
    {
      title: "List people",
      description:
        "Active members of a workspace: id, name, email and role. Use it to match names the person mentions.",
      inputSchema: z.object({ workspace: WORKSPACE }),
      annotations: READ_ONLY,
    },
    async ({ workspace }) =>
      inWorkspace(env, workspace, async (w) => {
        const people = (await listPeople(ctx, w.id))
          .filter((p) => p.active)
          .map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role }))
        return ok(`${people.length} people in ${w.name}.`, { workspace: w.name, people })
      }),
  )

  server.registerTool(
    "find_tasks",
    {
      title: "Find tasks",
      description:
        "Tasks the person can see in a workspace, soonest due first. scope: `mine` (default; their private tasks plus open workspace tasks assigned to them), `private`, `assigned`, `all` (administrators: every open workspace task), `completed`. Optional filters: words, due (`overdue`, `today`, `week` = next 7 days, `none`), status, priority.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        scope: z.enum(["mine", "private", "assigned", "all", "completed"]).optional(),
        search: z.string().max(200).optional().describe("Words to find in titles and descriptions"),
        due: z.enum(["overdue", "today", "week", "none"]).optional(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        page: z.number().int().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page, default 25"),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        const { today } = await workspaceClock(ctx, w.id, caller.userId)
        const limit = args.limit ?? 25
        const page = args.page ?? 1
        const filters: TaskFilters = {
          status: args.status,
          priority: args.priority,
          due: args.due,
          today,
        }
        const query = (scope: TaskScope, pageNo: number, pageSize: number) =>
          listTasks(ctx, w.id, { scope, search: args.search ?? "", page: pageNo, pageSize, filters })

        let items: Task[]
        let total: number
        if (!args.scope || args.scope === "mine") {
          // Private tasks and assigned workspace tasks, merged into one list.
          const [own, assigned] = await Promise.all([query("mine", 1, 100), query("assigned", 1, 100)])
          const merged = [...own.items, ...assigned.items].sort((a, b) => dueKey(a).localeCompare(dueKey(b)))
          total = own.total + assigned.total
          items = merged.slice((page - 1) * limit, page * limit)
        } else {
          const scope: TaskScope = args.scope === "private" ? "mine" : args.scope
          const result = await query(scope, page, limit)
          total = result.total
          items = result.items
        }
        const nameOf = await namesIn(ctx, w.id)
        const tasks = items.map((t) => taskSummary(t, nameOf, today, link.task(w.id, t.id)))
        const hasMore = page * limit < total
        return ok(`${total} task(s) in ${w.name}; showing ${tasks.length} (page ${page}).`, {
          workspace: w.name,
          today,
          total,
          page,
          hasMore,
          tasks,
        })
      }),
  )

  server.registerTool(
    "get_task",
    {
      title: "Get a task",
      description: "One task in full: description, dates, assignees and the meeting it came from.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        task: z.string().max(100).describe("Task id from find_tasks"),
      }),
      annotations: READ_ONLY,
    },
    async ({ workspace, task: id }) =>
      inWorkspace(env, workspace, async (w) => {
        const task = await getTask(ctx, w.id, id)
        const { today } = await workspaceClock(ctx, w.id, caller.userId)
        const nameOf = await namesIn(ctx, w.id)
        const meeting = task.meetingId
          ? await getMeeting(ctx, w.id, task.meetingId).catch(() => null)
          : null
        return ok(`Task "${task.title}".`, {
          ...taskSummary(task, nameOf, today, link.task(w.id, task.id)),
          description: task.description,
          start: task.startDate ? `${task.startDate}${task.startTime ? ` ${task.startTime}` : ""}` : null,
          createdBy: nameOf(task.createdById),
          createdAt: task.createdAt,
          completedAt: task.completedAt,
          meeting: meeting ? { id: meeting.id, title: meeting.title, date: meeting.date } : null,
        })
      }),
  )

  server.registerTool(
    "find_meetings",
    {
      title: "Find meetings",
      description:
        "Meetings the person can see between two dates (default: two weeks back to two weeks ahead, at most 92 days), optionally matching words in the title, agenda or location. Each says whether the person has written minutes for it.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        from: DATE.optional(),
        to: DATE.optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 50"),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        const { today } = await workspaceClock(ctx, w.id, caller.userId)
        const from = args.from ?? shiftDate(today, -14)
        const to = args.to ?? shiftDate(today, 14)
        if (to < from) return fail("`to` must be on or after `from`.")
        if (shiftDate(from, 92) < to) return fail("Search at most 92 days at a time.")
        const words = args.search?.trim().toLowerCase()
        const found = (await listMeetings(ctx, w.id, { from, to })).filter(
          (m) =>
            !words ||
            [m.title, m.notes, m.location].some((text) => text.toLowerCase().includes(words)),
        )
        const shown = found.slice(0, args.limit ?? 50)
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
        const nameOf = await namesIn(ctx, w.id)
        const meetings = shown.map((m) => ({
          id: m.id,
          title: m.title,
          date: m.date,
          start: m.startTime,
          end: m.endTime,
          location: m.location || null,
          organizer: nameOf(m.organizerId),
          attendees: m.attendeeIds.map(nameOf),
          hasMyMinutes: withMinutes.has(m.id),
          link: link.meeting(w.id, m.id, m.date),
        }))
        return ok(`${found.length} meeting(s) in ${w.name} from ${from} to ${to}; showing ${meetings.length}.`, {
          workspace: w.name,
          today,
          from,
          to,
          total: found.length,
          meetings,
        })
      }),
  )

  server.registerTool(
    "get_meeting",
    {
      title: "Get a meeting",
      description:
        "One meeting in full: time, place, organiser, attendees, agenda, its action items (tasks) and the minutes the person can read.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        meeting: z.string().max(100).describe("Meeting id from find_meetings"),
      }),
      annotations: READ_ONLY,
    },
    async ({ workspace, meeting: id }) =>
      inWorkspace(env, workspace, async (w) => {
        const meeting = await getMeeting(ctx, w.id, id)
        const [tasks, minutes, clock, nameOf] = await Promise.all([
          listMeetingTasks(ctx, w.id, meeting.id),
          listMeetingMinutes(ctx, w.id, meeting.id),
          workspaceClock(ctx, w.id, caller.userId),
          namesIn(ctx, w.id),
        ])
        return ok(`Meeting "${meeting.title}" on ${meeting.date}.`, {
          id: meeting.id,
          title: meeting.title,
          date: meeting.date,
          start: meeting.startTime,
          end: meeting.endTime,
          location: meeting.location || null,
          organizer: nameOf(meeting.organizerId),
          attendees: meeting.attendeeIds.map(nameOf),
          agenda: meeting.notes,
          translations: meeting.translations ?? null,
          actionItems: tasks.map((t) => taskSummary(t, nameOf, clock.today, link.task(w.id, t.id))),
          minutes: minutes.map((m) => ({
            id: m.id,
            author: nameOf(m.authorId),
            mine: m.authorId === caller.userId,
            visibility: m.visibility,
            updatedAt: m.updatedAt,
          })),
          link: link.meeting(w.id, meeting.id, meeting.date),
        })
      }),
  )

  server.registerTool(
    "get_minutes",
    {
      title: "Get minutes",
      description:
        "Meeting minutes the person can read: one set by `minutes` id, or every readable set for a `meeting` (their own first).",
      inputSchema: z.object({
        workspace: WORKSPACE,
        minutes: z.string().max(100).optional().describe("Minutes id from get_meeting"),
        meeting: z.string().max(100).optional().describe("Meeting id from find_meetings"),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        const nameOf = await namesIn(ctx, w.id)
        const shape = (m: MeetingMinutes) =>
          minutesShape(m, nameOf, caller.userId, link.minutes(w.id, m.id))
        if (args.minutes) {
          const minutes = await getMinutes(ctx, w.id, args.minutes)
          return ok(`Minutes of "${minutes.meetingTitle}".`, shape(minutes))
        }
        if (args.meeting) {
          const list = (await listMeetingMinutes(ctx, w.id, args.meeting)).map(shape)
          return ok(`${list.length} set(s) of minutes for this meeting.`, { minutes: list })
        }
        return fail("Pass `minutes` (an id from get_meeting) or `meeting` (an id from find_meetings).")
      }),
  )
}
