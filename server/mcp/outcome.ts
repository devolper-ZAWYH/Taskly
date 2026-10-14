/**
 * Everything from one meeting in one go: its minutes, tasks for the team, the
 * person's own tasks and the next meeting, from a single message.
 *   review_meeting_outcome → create_meeting_outcome
 * The review checks every part and matches every name at once, then shows one
 * card; the person confirms once (leaving out any part they don't want). Each
 * part is created with the same service functions as the single-item tools,
 * so permissions, notifications, Google sync and translation are unchanged.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server"
import type { McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import { AppError } from "@/lib/api/core"
import type { MeetingInput, MinutesInput, TaskInput } from "@/lib/types"
import en from "@/messages/en"
import {
  checkNewMeeting,
  expired,
  named,
  needsChoice,
  PEOPLE,
  resolvePeople,
  understood,
  WRITE,
  type Resolved,
} from "@/server/mcp/actions"
import { CARD_META } from "@/server/mcp/cards/resource"
import type { MinutesReaders, OutcomeResult, OutcomeReview } from "@/server/mcp/cards/types"
import { saveDraft, takeDraft } from "@/server/mcp/drafts"
import {
  ADDITIVE,
  cardView,
  DATE,
  fail,
  inWorkspace,
  links,
  longDate,
  ok,
  okCard,
  TIME,
  WORKSPACE,
  type ToolEnv,
} from "@/server/mcp/shared"
import { workspaceClock } from "@/server/mcp/workspaces"
import { createMeeting, getMeeting } from "@/server/services/meetings"
import { listPeople } from "@/server/services/members"
import { createMinutes, listMeetingMinutes, updateMinutes } from "@/server/services/minutes"
import { createTask } from "@/server/services/tasks"
import { PRIORITIES } from "@/server/validate"

const MAX_TASKS = 30
const MAX_MY_TASKS = 20

const TASK = {
  title: z.string().min(1).max(300),
  notes: z.string().max(20_000).optional(),
  due_date: DATE.optional().describe("YYYY-MM-DD, from what they said and list_workspaces' `today`"),
  due_time: TIME.optional().describe("HH:MM, only if they gave a time"),
  priority: z.enum(PRIORITIES).optional(),
}

/** What a review holds until the person confirms it. */
type OutcomeDraft = {
  meetingId: string
  minutes: { input: MinutesInput; replace: boolean } | null
  tasks: { key: string; input: TaskInput }[]
  myTasks: { key: string; input: TaskInput }[]
  nextMeeting: MeetingInput | null
}

type TaskArgs = { title: string; notes?: string; due_date?: string; due_time?: string; priority?: TaskInput["priority"] }

function taskInput(t: TaskArgs, assigneeIds: string[], meetingId: string | null, isPrivate: boolean): TaskInput {
  return {
    title: t.title.trim(),
    description: t.notes ?? "",
    status: "open",
    priority: t.priority ?? "none",
    startDate: "",
    startTime: "",
    dueDate: t.due_date ?? "",
    dueTime: t.due_date ? (t.due_time ?? "") : "",
    assigneeIds,
    meetingId,
    private: isPrivate,
    googleSync: false,
  }
}

const dueOf = (input: TaskInput) =>
  input.dueDate ? `${input.dueDate}${input.dueTime ? ` ${input.dueTime}` : ""}` : null

const andList = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

export function registerOutcomeTools(server: McpServer, env: ToolEnv): void {
  const { ctx, caller, urls } = env
  const link = links(urls)

  registerAppTool(
    server,
    "review_meeting_outcome",
    {
      title: "Review everything from a meeting",
      description:
        "Step 1 when the person gives several things from one meeting together (their notes or decisions, tasks for people, their own tasks, the next meeting): checks all of it and matches every name at once, without creating anything. Include every part they gave. Write titles, notes, minutes and the agenda in the language they wrote in; don't translate. Show the review (read `spokenSummary` aloud in voice) and ask them to confirm; then call create_meeting_outcome with the `draft`. In the Claude apps the review is one card where they can untick parts and press Create all. Tasks for other people and the next meeting are for administrators.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        meeting: z.string().max(100).describe("Id of the meeting this is from (find_meetings, or choose_meeting when unclear)"),
        minutes: z
          .object({
            body: z
              .string()
              .min(1)
              .max(50_000)
              .describe("Minutes drafted from their notes: Summary, Attendees, Decisions, Action items (who, what, by when), Next steps"),
            readers: z
              .enum(["attendees", "workspace", "private", "people"])
              .describe("Who may read them. If they didn't say, use attendees (the meeting's organiser and attendees); the card shows it."),
            share_with: PEOPLE.optional().describe("Who may read them when readers is people"),
            replace: z.boolean().optional().describe("Replace minutes they already have for this meeting; only after asking them"),
          })
          .optional(),
        tasks: z
          .array(z.object({ ...TASK, assignees: PEOPLE.min(1) }))
          .max(MAX_TASKS)
          .optional()
          .describe("Action items for other people, linked to the meeting (administrators only)"),
        my_tasks: z
          .array(z.object(TASK))
          .max(MAX_MY_TASKS)
          .optional()
          .describe("Private tasks for the person themselves; only they see them"),
        next_meeting: z
          .object({
            title: z.string().min(1).max(300),
            date: DATE,
            start_time: TIME,
            end_time: TIME.optional(),
            duration_minutes: z.number().int().min(5).max(720).optional().describe("Instead of end_time"),
            attendees: PEOPLE.optional(),
            location: z.string().max(500).optional().describe("Room or call link"),
            agenda: z.string().max(20_000).optional(),
          })
          .optional()
          .describe("The follow-up meeting, if they planned one (administrators only). Ask for its date, start time and length if missing."),
      }),
      annotations: { ...ADDITIVE, readOnlyHint: true, idempotentHint: true },
      _meta: CARD_META,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        const teamArgs = args.tasks ?? []
        const myArgs = args.my_tasks ?? []
        if (!args.minutes && teamArgs.length === 0 && myArgs.length === 0 && !args.next_meeting) {
          return fail("Nothing to review: include the minutes, tasks for people, their own tasks or the next meeting.")
        }
        if (w.role !== "administrator" && (teamArgs.length > 0 || args.next_meeting)) {
          return fail(
            `Only administrators of ${w.name} can give tasks to other people or schedule meetings. Tell the person, suggest asking an administrator for those, and review again with only the minutes and their own tasks.`,
            "not_admin",
          )
        }

        const meeting = await getMeeting(ctx, w.id, args.meeting)
        const members = await listPeople(ctx, w.id)

        // Every name at once, so the person settles all the unclear ones together.
        const minutesNames = args.minutes?.readers === "people" ? (args.minutes.share_with ?? []) : []
        const allNames = [
          ...new Set([
            ...teamArgs.flatMap((t) => t.assignees),
            ...(args.next_meeting?.attendees ?? []),
            ...minutesNames,
          ]),
        ]
        const everyone = await resolvePeople(ctx, w, allNames, members)
        if (!("people" in everyone)) return needsChoice(env, w, everyone, "outcome")
        const peopleFor = async (names: string[]): Promise<Resolved[]> => {
          const found = await resolvePeople(ctx, w, names, members)
          return "people" in found ? found.people : []
        }

        const { today } = await workspaceClock(ctx, w.id, caller.userId)
        const warnings: string[] = [...understood(everyone.people)]
        const pastDue = (input: TaskInput) => {
          const past = Boolean(input.dueDate) && input.dueDate < today
          if (past) warnings.push(`"${input.title}" is due ${input.dueDate}, which has already passed`)
          return past
        }

        // ---- Minutes ----
        let minutes: OutcomeDraft["minutes"] = null
        let minutesReview: OutcomeReview["minutes"] = null
        if (args.minutes) {
          let readers: MinutesReaders
          let sharedWithIds: string[] = []
          if (args.minutes.readers === "attendees" || args.minutes.readers === "people") {
            const people =
              args.minutes.readers === "people"
                ? await peopleFor(minutesNames)
                : members
                    .filter((m) => m.active && m.id !== caller.userId)
                    .filter((m) => m.id === meeting.organizerId || meeting.attendeeIds.includes(m.id))
                    .map((m) => ({ id: m.id, name: m.name, email: m.email, avatarUrl: m.avatarUrl }))
            if (args.minutes.readers === "people" && people.length === 0) {
              return fail("Say who may read the minutes, or use readers attendees, workspace or private.")
            }
            sharedWithIds = people.map((p) => p.id)
            readers = people.length > 0 ? { kind: "people", people: named(people) } : { kind: "private" }
          } else {
            readers = { kind: args.minutes.readers }
          }
          const mine = (await listMeetingMinutes(ctx, w.id, meeting.id)).find((m) => m.authorId === caller.userId)
          if (mine && !args.minutes.replace) {
            return fail(
              `The person already has minutes for "${meeting.title}" (last saved ${mine.updatedAt}). Ask whether to replace them; if yes, review again with minutes.replace: true.`,
            )
          }
          minutes = { input: { body: args.minutes.body, visibility: readers.kind, sharedWithIds }, replace: Boolean(mine) }
          minutesReview = { key: "minutes", body: args.minutes.body, readers, replaces: Boolean(mine) }
        }

        // ---- Tasks ----
        const tasks: OutcomeDraft["tasks"] = []
        const tasksReview: OutcomeReview["tasks"] = []
        for (const [i, t] of teamArgs.entries()) {
          const people = await peopleFor(t.assignees)
          const input = taskInput(t, people.map((p) => p.id), meeting.id, false)
          const key = `t${i + 1}`
          tasks.push({ key, input })
          tasksReview.push({
            key,
            title: input.title,
            assignees: named(people),
            due: dueOf(input),
            pastDue: pastDue(input),
            priority: input.priority,
          })
        }
        const myTasks: OutcomeDraft["myTasks"] = []
        const myTasksReview: OutcomeReview["myTasks"] = []
        for (const [i, t] of myArgs.entries()) {
          // Private tasks stay off the meeting, which others can see.
          const input = taskInput(t, [caller.userId], null, true)
          const key = `p${i + 1}`
          myTasks.push({ key, input })
          myTasksReview.push({ key, title: input.title, due: dueOf(input), pastDue: pastDue(input), priority: input.priority })
        }

        // ---- Next meeting ----
        let nextMeeting: MeetingInput | null = null
        let nextReview: OutcomeReview["nextMeeting"] = null
        if (args.next_meeting) {
          const checked = await checkNewMeeting(env, w, args.next_meeting)
          if ("error" in checked) return fail(`Next meeting: ${checked.error}`)
          if ("unresolved" in checked) return needsChoice(env, w, checked.unresolved, "outcome")
          warnings.push(...checked.warnings)
          nextMeeting = checked.input
          nextReview = {
            key: "next_meeting",
            title: checked.input.title,
            date: checked.input.date,
            start: checked.input.startTime,
            end: checked.input.endTime,
            timeZone: checked.timeZone,
            attendees: named(checked.attendees),
            location: checked.input.location || null,
            agenda: checked.input.notes || null,
            clashes: checked.clashes,
            past: checked.past,
          }
        }

        const draftPayload: OutcomeDraft = { meetingId: meeting.id, minutes, tasks, myTasks, nextMeeting }
        const draft = await saveDraft(ctx, { userId: caller.userId, accountId: w.id, kind: "outcome", payload: draftPayload })

        const readersText = (r: MinutesReaders) =>
          r.kind === "private" ? "only you" : r.kind === "workspace" ? `everyone in ${w.name}` : `you and ${andList(r.people.map((p) => p.name))}`
        const assigned = [...new Set(tasksReview.flatMap((t) => t.assignees.map((p) => p.name)))]
        const parts = [
          minutesReview && `minutes readable by ${readersText(minutesReview.readers)}${minutesReview.replaces ? " (replacing your earlier minutes)" : ""}`,
          tasksReview.length > 0 &&
            `${tasksReview.length === 1 ? "1 task" : `${tasksReview.length} tasks`} for ${andList(assigned)}`,
          myTasksReview.length > 0 && `${myTasksReview.length === 1 ? "1 private task" : `${myTasksReview.length} private tasks`} for you`,
          nextReview &&
            `the next meeting "${nextReview.title}" on ${longDate(nextReview.date)}, ${nextReview.start} to ${nextReview.end}`,
        ].filter((part): part is string => Boolean(part))
        const sentence = `From "${meeting.title}": ${andList(parts)}.`
        const notes = [...new Set(warnings)]
        const caution = notes.length ? ` Note: ${notes.join("; ")}.` : ""

        const review: OutcomeReview = {
          status: "ready",
          draft,
          expiresInMinutes: 15,
          workspace: w.name,
          meeting: { id: meeting.id, title: meeting.title, date: meeting.date },
          minutes: minutesReview,
          tasks: tasksReview,
          myTasks: myTasksReview,
          nextMeeting: nextReview,
          warnings: notes,
          spokenSummary: `${sentence}${caution} Shall I create everything?`,
          next: "If the person confirms, call create_meeting_outcome with this draft (with `skip` for any part they want left out, by its key). If they press Create all on the card instead, it is created there and you'll be told; don't create it again. If they change anything else, review again.",
        }
        const shown = new Set([
          ...everyone.people.map((p) => p.id),
          ...(minutesReview?.readers.kind === "people" ? minutesReview.readers.people.map((p) => p.id) : []),
          ...(nextReview?.attendees.map((p) => p.id) ?? []),
        ])
        return okCard(
          `${sentence}${caution} Waiting for the person to confirm.`,
          review,
          await cardView(env, w, "outcome", members.filter((m) => shown.has(m.id))),
        )
      }),
  )

  server.registerTool(
    "create_meeting_outcome",
    {
      title: "Create the reviewed meeting outcome",
      description:
        'Step 2: create everything from a review_meeting_outcome `draft`, only after the person confirmed that review. `skip` leaves out parts by their key ("minutes", "t1"…, "p1"…, "next_meeting") when the person asked to drop them. Assignees and attendees are notified as usual. If some parts fail, the rest are still created; tell the person which failed.',
      inputSchema: z.object({
        workspace: WORKSPACE,
        draft: z.string().max(100),
        skip: z.array(z.string().max(40)).max(60).optional(),
      }),
      annotations: ADDITIVE,
      ...WRITE,
    },
    async ({ workspace, draft, skip }) =>
      inWorkspace(env, workspace, async (w) => {
        const d = await takeDraft<OutcomeDraft>(ctx, { id: draft, userId: caller.userId, accountId: w.id, kind: "outcome" })
        if (!d) return fail(expired("review_meeting_outcome"), "expired")
        const skipped = new Set(skip ?? [])
        const result: OutcomeResult = { created: [], failed: [], skipped: [...skipped] }

        // One part at a time; a part that fails doesn't stop the others.
        async function attempt(
          key: string,
          title: string,
          work: () => Promise<Omit<OutcomeResult["created"][number], "key">>,
        ) {
          if (skipped.has(key)) return
          try {
            result.created.push({ key, ...(await work()) })
          } catch (error) {
            if (!(error instanceof AppError)) console.error(`meeting outcome part ${key} failed`, error)
            const message =
              error instanceof AppError
                ? ((en.errors as Record<string, string>)[error.code] ?? error.code)
                : "Something went wrong"
            result.failed.push({ key, title, error: message })
          }
        }

        if (d.minutes) {
          const { input, replace } = d.minutes
          await attempt("minutes", "Minutes", async () => {
            const mine = replace
              ? (await listMeetingMinutes(ctx, w.id, d.meetingId)).find((m) => m.authorId === caller.userId)
              : undefined
            const saved = mine
              ? await updateMinutes(ctx, w.id, mine.id, input, mine.updatedAt)
              : await createMinutes(ctx, w.id, d.meetingId, input)
            return { kind: "minutes", title: saved.meetingTitle, link: link.minutes(w.id, saved.id) }
          })
        }
        for (const { key, input } of d.tasks) {
          await attempt(key, input.title, async () => {
            const task = await createTask(ctx, w.id, input)
            return { kind: "task", title: task.title, link: link.task(w.id, task.id) }
          })
        }
        for (const { key, input } of d.myTasks) {
          await attempt(key, input.title, async () => {
            const task = await createTask(ctx, w.id, input)
            return { kind: "my_task", title: task.title, link: link.task(w.id, task.id) }
          })
        }
        if (d.nextMeeting) {
          const input = d.nextMeeting
          await attempt("next_meeting", input.title, async () => {
            const meeting = await createMeeting(ctx, w.id, input)
            return { kind: "meeting", title: meeting.title, link: link.meeting(w.id, meeting.id, meeting.date) }
          })
        }

        const total = result.created.length + result.failed.length
        const names = result.created
          .map((c) => (c.kind === "minutes" ? `the minutes of "${c.title}"` : `"${c.title}"`))
          .join(", ")
        const leftOut = result.skipped.length ? ` Left out as the person asked: ${result.skipped.join(", ")}.` : ""
        const summary =
          total === 0
            ? "Nothing was created: every part was left out."
            : result.failed.length === 0
              ? `Created ${result.skipped.length ? total : `all ${total}`}: ${names}.${leftOut}`
              : `Created ${result.created.length} of ${total}: ${names}. Not created: ${result.failed
                  .map((f) => `"${f.title}" (${f.error})`)
                  .join("; ")}. Tell the person; they can be added one by one.${leftOut}`
        return ok(summary, result)
      }),
  )
}
