/**
 * The write actions (phase 2 of docs/plan-claude-connector.md), reached by
 * plain language rather than commands:
 *   - a task for yourself:    create_my_task
 *   - minutes of a meeting:   save_minutes
 *   - a task for others:      review_task_delegation → delegate_task (administrators)
 *   - a meeting:              review_meeting → create_meeting (administrators)
 *   - plus set_task_status.
 * Every one calls the app's own service functions as the signed-in person, so
 * permissions, notifications, email, Google sync and translation behave as in
 * the app. Giving tasks to others and creating meetings need a draft that a
 * review issued (drafts.ts), so Claude can't skip showing the review.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server"
import { requireScopes, type CallToolResult, type McpServer } from "@modelcontextprotocol/server"
import * as z from "zod/v4"
import type { MeetingInput, TaskInput } from "@/lib/types"
import type { Ctx } from "@/server/context"
import { wallClock } from "@/server/google/mapping"
import { CARD_META } from "@/server/mcp/cards/resource"
import type { DelegationReview, MeetingReview, NamedPerson, NeedsChoice } from "@/server/mcp/cards/types"
import { saveDraft, takeDraft } from "@/server/mcp/drafts"
import { matchPerson, type Person } from "@/server/mcp/match"
import {
  ADDITIVE,
  cardView,
  DATE,
  fail,
  inWorkspace,
  links,
  longDate,
  namesIn,
  ok,
  okCard,
  TIME,
  taskSummary,
  WORKSPACE,
  type ToolEnv,
} from "@/server/mcp/shared"
import { minutesShape } from "@/server/mcp/tools"
import { workspaceClock, type Workspace } from "@/server/mcp/workspaces"
import { createMeeting, getMeeting, listMeetings } from "@/server/services/meetings"
import { listPeople } from "@/server/services/members"
import { createMinutes, listMeetingMinutes, updateMinutes } from "@/server/services/minutes"
import { createTask, updateTask } from "@/server/services/tasks"
import { PRIORITIES } from "@/server/validate"

/** Writing needs the `taskly.write` scope; a read-only connection is asked to step up. */
const WRITE = { scopeChallenge: requireScopes("taskly.write") }

const PEOPLE = z
  .array(z.string().min(1).max(200))
  .max(50)
  .describe("Names, emails or ids, as the person said them. Misspellings and Arabic spellings are fine.")

const notAdmin = (w: Workspace, what: string) =>
  `Only administrators of ${w.name} can ${what}. Tell the person, suggest asking an administrator, and don't create anything.`

const CONFIRM = (create: string) =>
  `If the person confirms, call ${create} with this draft. If they press Create on the card instead, it is created there and you'll be told; don't create it again. If they change anything, review again.`

const expired = (review: string) =>
  `This review has expired (they last 15 minutes) or was already used. Run ${review} again and show the person the new summary.`

type Resolved = Person & { understoodFrom?: string; avatarUrl: string | null }

type Unresolved = { choices: NeedsChoice["choices"]; missing: string[] }

/**
 * Turn what the person said into members. Returns the choices instead when a
 * name fits several people, or nobody: Claude must ask, never guess.
 */
async function resolvePeople(
  ctx: Ctx,
  w: Workspace,
  queries: string[],
): Promise<{ people: Resolved[] } | Unresolved> {
  const members = (await listPeople(ctx, w.id)).filter((m) => m.active)
  const avatars = new Map(members.map((m) => [m.id, m.avatarUrl]))
  const people: Resolved[] = []
  const unresolved: Unresolved = { choices: [], missing: [] }
  for (const query of queries) {
    const match = matchPerson(
      query,
      members.map((m) => ({ id: m.id, name: m.name, email: m.email })),
    )
    if (match.kind === "found") {
      if (!people.some((p) => p.id === match.person.id)) {
        const person = { ...match.person, avatarUrl: avatars.get(match.person.id) ?? null }
        // Flag only uncertain matches; the review names everyone in full anyway.
        people.push(match.quality === "similar" ? { ...person, understoodFrom: query } : person)
      }
    } else if (match.kind === "ambiguous") {
      unresolved.choices.push({ query, candidates: match.candidates })
    } else {
      unresolved.missing.push(query)
    }
  }
  if (unresolved.choices.length > 0 || unresolved.missing.length > 0) return unresolved
  return { people }
}

/** For Claude: who the unclear names could be. */
function unclear(w: Workspace, { choices, missing }: Unresolved): string {
  return [
    ...choices.map(
      (c) => `"${c.query}" could be: ${c.candidates.map((p) => `${p.name} (${p.email})`).join(", ")}.`,
    ),
    ...missing.map((query) => `Nobody in ${w.name} matches "${query}".`),
  ].join(" ")
}

/**
 * A review that can't be drafted until the person says who they meant. The
 * card offers the candidates; Claude asks in words.
 */
async function needsChoice(
  env: ToolEnv,
  w: Workspace,
  unresolved: Unresolved,
  card: "delegation" | "meeting",
): Promise<CallToolResult> {
  const shown = new Set(unresolved.choices.flatMap((c) => c.candidates.map((p) => p.id)))
  const people = (await listPeople(env.ctx, w.id)).filter((p) => shown.has(p.id))
  const data: NeedsChoice = {
    status: "needs_choice",
    workspace: w.name,
    ...unresolved,
    next: "Nothing was drafted. Ask the person who they mean (list_people shows everyone; in the Claude apps they can also choose on the card), then review again with their choice.",
  }
  return okCard(`${unclear(w, unresolved)} Nothing was drafted yet.`, data, await cardView(env, w, card, people))
}

const named = (people: Resolved[]): NamedPerson[] =>
  people.map((p) => ({ id: p.id, name: p.name, email: p.email, understoodFrom: p.understoodFrom ?? null }))

const nameList = (people: Resolved[]) =>
  people.length <= 1
    ? (people[0]?.name ?? "")
    : `${people.slice(0, -1).map((p) => p.name).join(", ")} and ${people.at(-1)!.name}`

/** "(understood "Umar" as Omar Khalil)" notes, so the person can catch a wrong match. */
const understood = (people: Resolved[]) =>
  people
    .filter((p) => p.understoodFrom)
    .map((p) => `understood "${p.understoodFrom}" as ${p.name}`)

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
const fromMinutes = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

export function registerWriteTools(server: McpServer, env: ToolEnv): void {
  const { ctx, caller, urls } = env
  const link = links(urls)

  server.registerTool(
    "create_my_task",
    {
      title: "Add a task for yourself",
      description:
        'Add a private task for the person: only they see it, and they are its only assignee. Use it for "add a task…", "remind me to…", "I need to…". No review needed. For tasks for other people, use review_task_delegation instead.',
      inputSchema: z.object({
        workspace: WORKSPACE,
        title: z.string().min(1).max(300),
        notes: z.string().max(20_000).optional(),
        due_date: DATE.optional().describe("YYYY-MM-DD, read from what they said using list_workspaces' `today`"),
        due_time: TIME.optional().describe("HH:MM, only if they gave a time"),
        priority: z.enum(PRIORITIES).optional(),
      }),
      annotations: ADDITIVE,
      ...WRITE,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        const input: TaskInput = {
          title: args.title,
          description: args.notes ?? "",
          status: "open",
          priority: args.priority ?? "none",
          startDate: "",
          startTime: "",
          dueDate: args.due_date ?? "",
          dueTime: args.due_date ? (args.due_time ?? "") : "",
          assigneeIds: [caller.userId],
          meetingId: null,
          private: true,
          googleSync: false,
        }
        const task = await createTask(ctx, w.id, input)
        const [{ today }, nameOf] = await Promise.all([
          workspaceClock(ctx, w.id, caller.userId),
          namesIn(ctx, w.id),
        ])
        const due = task.dueDate ? `, due ${longDate(task.dueDate)}${task.dueTime ? ` at ${task.dueTime}` : ""}` : ""
        return ok(`Added your private task "${task.title}"${due} in ${w.name}.`, {
          task: taskSummary(task, nameOf, today, link.task(w.id, task.id)),
        })
      }),
  )

  server.registerTool(
    "set_task_status",
    {
      title: "Update a task's status",
      description:
        "Mark a task the person can see as open, in progress, on hold or completed (\"I've finished…\", \"reopen…\"). Members can do this for tasks assigned to them.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        task: z.string().max(100).describe("Task id from find_tasks"),
        status: z.enum(["open", "in_progress", "on_hold", "completed"]),
      }),
      annotations: { ...ADDITIVE, idempotentHint: true },
      ...WRITE,
    },
    async ({ workspace, task: id, status }) =>
      inWorkspace(env, workspace, async (w) => {
        const task = await updateTask(ctx, w.id, id, { status })
        const [{ today }, nameOf] = await Promise.all([
          workspaceClock(ctx, w.id, caller.userId),
          namesIn(ctx, w.id),
        ])
        return ok(`"${task.title}" is now ${status.replace("_", " ")}.`, {
          task: taskSummary(task, nameOf, today, link.task(w.id, task.id)),
        })
      }),
  )

  server.registerTool(
    "save_minutes",
    {
      title: "Save meeting minutes",
      description:
        "Save the person's minutes of a meeting, after they have seen the draft and chosen who may read it: `private` (only them), `workspace` (everyone in it) or `people` (`share_with`). If they already have minutes for that meeting this fails, unless `replace` is true; ask them first.",
      inputSchema: z.object({
        workspace: WORKSPACE,
        meeting: z.string().max(100).describe("Meeting id from find_meetings"),
        body: z.string().min(1).max(50_000).describe("The minutes as the person approved them"),
        visibility: z.enum(["private", "workspace", "people"]),
        share_with: PEOPLE.optional().describe("Who may read them when visibility is `people`"),
        replace: z.boolean().optional().describe("Replace minutes they already have for this meeting"),
      }),
      annotations: { ...ADDITIVE, destructiveHint: true },
      ...WRITE,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        let sharedWithIds: string[] = []
        let readers = args.visibility === "private" ? "only you" : `everyone in ${w.name}`
        if (args.visibility === "people") {
          const resolved = await resolvePeople(ctx, w, args.share_with ?? [])
          if (!("people" in resolved)) {
            return fail(`${unclear(w, resolved)} Ask the person who they mean (list_people shows everyone), then try again.`)
          }
          if (resolved.people.length === 0) return fail("Say who may read them, or choose `private` or `workspace`.")
          sharedWithIds = resolved.people.map((p) => p.id)
          readers = `you and ${nameList(resolved.people)}`
        }
        const input = { body: args.body, visibility: args.visibility, sharedWithIds }
        const mine = (await listMeetingMinutes(ctx, w.id, args.meeting)).find(
          (m) => m.authorId === caller.userId,
        )
        if (mine && !args.replace) {
          return fail(
            `The person already has minutes for this meeting (last saved ${mine.updatedAt}). Ask whether to replace them; if yes, call save_minutes again with replace: true and the complete text.`,
          )
        }
        const minutes = mine
          ? await updateMinutes(ctx, w.id, mine.id, input, mine.updatedAt)
          : await createMinutes(ctx, w.id, args.meeting, input)
        const nameOf = await namesIn(ctx, w.id)
        return ok(
          `${mine ? "Replaced" : "Saved"} your minutes of "${minutes.meetingTitle}" (${minutes.meetingDate}); readable by ${readers}.`,
          minutesShape(minutes, nameOf, caller.userId, link.minutes(w.id, minutes.id)),
        )
      }),
  )

  // Administrators only: hidden from people who are an administrator nowhere.
  if (!env.workspaces.some((w) => w.role === "administrator")) return

  registerAppTool(
    server,
    "review_task_delegation",
    {
      title: "Review a task for others",
      description:
        'Step 1 of giving someone a task ("give Omar…", "assign … to Sara"): checks it and matches the names, without creating anything. Show the person the summary (read `spokenSummary` aloud in voice) and ask them to confirm; then call delegate_task with the `draft`. In the Claude apps the review is also a card with Create and Discard buttons. Administrators only.',
      inputSchema: z.object({
        workspace: WORKSPACE,
        title: z.string().min(1).max(300),
        assignees: PEOPLE.min(1),
        notes: z.string().max(20_000).optional(),
        due_date: DATE.optional(),
        due_time: TIME.optional(),
        priority: z.enum(PRIORITIES).optional(),
        meeting: z.string().max(100).optional().describe("Meeting id, when it's an action item of a meeting"),
      }),
      annotations: { ...ADDITIVE, readOnlyHint: true, idempotentHint: true },
      _meta: CARD_META,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        if (w.role !== "administrator") return fail(notAdmin(w, "give tasks to other people"), "not_admin")
        const resolved = await resolvePeople(ctx, w, args.assignees)
        if (!("people" in resolved)) return needsChoice(env, w, resolved, "delegation")
        const meeting = args.meeting ? await getMeeting(ctx, w.id, args.meeting) : null
        const { today } = await workspaceClock(ctx, w.id, caller.userId)

        const input: TaskInput = {
          title: args.title.trim(),
          description: args.notes ?? "",
          status: "open",
          priority: args.priority ?? "none",
          startDate: "",
          startTime: "",
          dueDate: args.due_date ?? "",
          dueTime: args.due_date ? (args.due_time ?? "") : "",
          assigneeIds: resolved.people.map((p) => p.id),
          meetingId: meeting?.id ?? null,
          private: false,
          googleSync: false,
        }
        const warnings = [...understood(resolved.people)]
        const pastDue = Boolean(input.dueDate) && input.dueDate < today
        if (pastDue) warnings.push(`the due date ${input.dueDate} has already passed`)
        const draft = await saveDraft(ctx, { userId: caller.userId, accountId: w.id, kind: "delegation", payload: input })

        const due = input.dueDate ? `, due ${longDate(input.dueDate)}${input.dueTime ? ` at ${input.dueTime}` : ""}` : ""
        const priority = input.priority !== "none" ? `, ${input.priority} priority` : ""
        const from = meeting ? `, from "${meeting.title}"` : ""
        const sentence = `Give "${input.title}" to ${nameList(resolved.people)}${due}${priority}${from}.`
        const caution = warnings.length ? ` Note: ${warnings.join("; ")}.` : ""
        const review: DelegationReview = {
          status: "ready",
          draft,
          expiresInMinutes: 15,
          workspace: w.name,
          title: input.title,
          assignees: named(resolved.people),
          due: input.dueDate ? `${input.dueDate}${input.dueTime ? ` ${input.dueTime}` : ""}` : null,
          pastDue,
          priority: input.priority,
          meeting: meeting ? { id: meeting.id, title: meeting.title } : null,
          warnings,
          spokenSummary: `${sentence}${caution} Shall I create it?`,
          next: CONFIRM("delegate_task"),
        }
        return okCard(
          `${sentence}${caution} Waiting for the person to confirm.`,
          review,
          await cardView(env, w, "delegation", resolved.people),
        )
      }),
  )

  server.registerTool(
    "delegate_task",
    {
      title: "Create the reviewed task",
      description:
        "Step 2: create the task from a review_task_delegation `draft`, only after the person confirmed that review. Assignees are notified as usual. Administrators only.",
      inputSchema: z.object({ workspace: WORKSPACE, draft: z.string().max(100) }),
      annotations: ADDITIVE,
      ...WRITE,
    },
    async ({ workspace, draft }) =>
      inWorkspace(env, workspace, async (w) => {
        if (w.role !== "administrator") return fail(notAdmin(w, "give tasks to other people"), "not_admin")
        const input = await takeDraft<TaskInput>(ctx, { id: draft, userId: caller.userId, accountId: w.id, kind: "delegation" })
        if (!input) return fail(expired("review_task_delegation"), "expired")
        const task = await createTask(ctx, w.id, input)
        const [{ today }, nameOf] = await Promise.all([
          workspaceClock(ctx, w.id, caller.userId),
          namesIn(ctx, w.id),
        ])
        const summary = taskSummary(task, nameOf, today, link.task(w.id, task.id))
        return ok(`Created "${task.title}" for ${summary.assignees.join(", ")}.`, { task: summary })
      }),
  )

  registerAppTool(
    server,
    "review_meeting",
    {
      title: "Review a new meeting",
      description:
        'Step 1 of scheduling a meeting ("set up a meeting with…"). First ask the person for anything missing: title, date, start time, end time or length, attendees (location and agenda are optional). This checks it, matches the names and finds clashes in attendees\' calendars, without creating anything. Show the review (read `spokenSummary` aloud in voice) and ask them to confirm; then call create_meeting with the `draft`. In the Claude apps the review is also a card with Create and Discard buttons. Administrators only.',
      inputSchema: z.object({
        workspace: WORKSPACE,
        title: z.string().min(1).max(300),
        date: DATE,
        start_time: TIME,
        end_time: TIME.optional(),
        duration_minutes: z.number().int().min(5).max(720).optional().describe("Instead of end_time"),
        attendees: PEOPLE.optional(),
        location: z.string().max(500).optional().describe("Room or call link"),
        agenda: z.string().max(20_000).optional(),
      }),
      annotations: { ...ADDITIVE, readOnlyHint: true, idempotentHint: true },
      _meta: CARD_META,
    },
    async (args) =>
      inWorkspace(env, args.workspace, async (w) => {
        if (w.role !== "administrator") return fail(notAdmin(w, "schedule meetings"), "not_admin")
        const start = toMinutes(args.start_time)
        const end = args.end_time
          ? toMinutes(args.end_time)
          : args.duration_minutes
            ? start + args.duration_minutes
            : null
        if (end === null) return fail("Ask the person how long the meeting is, or when it ends.")
        if (end <= start) return fail("The meeting must end after it starts.")
        if (end >= 24 * 60) return fail("Meetings must end on the same day.")
        const endTime = fromMinutes(end)

        const resolved = await resolvePeople(ctx, w, args.attendees ?? [])
        if (!("people" in resolved)) return needsChoice(env, w, resolved, "meeting")
        const attendees = resolved.people.filter((p) => p.id !== caller.userId)

        // Clashes: other meetings that day that overlap and involve anyone invited (or the organiser).
        const involved = new Set([caller.userId, ...attendees.map((p) => p.id)])
        const [sameDay, nameOf, clock] = await Promise.all([
          listMeetings(ctx, w.id, { from: args.date, to: args.date }),
          namesIn(ctx, w.id),
          workspaceClock(ctx, w.id, caller.userId),
        ])
        const clashes = sameDay.flatMap((m) => {
          if (!(toMinutes(m.startTime) < end && start < toMinutes(m.endTime))) return []
          const who = [m.organizerId, ...m.attendeeIds].filter((id) => involved.has(id))
          return [...new Set(who)].map((id) => ({
            personId: id,
            person: id === caller.userId ? "You" : (nameOf(id) ?? ""),
            meeting: m.title,
            time: `${m.startTime}–${m.endTime}`,
          }))
        })
        const warnings = [
          ...understood(attendees),
          ...clashes.map((c) => `${c.person} ${c.person === "You" ? "have" : "has"} "${c.meeting}" at ${c.time}`),
        ]
        const now = wallClock(new Date(), clock.timeZone)
        const past = args.date < clock.today || (args.date === clock.today && args.start_time < now.time)
        if (past) warnings.push("that time has already passed")

        const input: MeetingInput = {
          title: args.title.trim(),
          notes: args.agenda ?? "",
          date: args.date,
          startTime: args.start_time,
          endTime,
          location: args.location?.trim() ?? "",
          attendeeIds: attendees.map((p) => p.id),
        }
        const draft = await saveDraft(ctx, { userId: caller.userId, accountId: w.id, kind: "meeting", payload: input })

        const withWhom = attendees.length ? ` with ${nameList(attendees)}` : ""
        const place = input.location ? ` at ${input.location}` : ""
        const sentence = `Create "${input.title}" on ${longDate(input.date)}, ${input.startTime} to ${endTime}${withWhom}${place}.`
        const caution = warnings.length ? ` Note: ${warnings.join("; ")}.` : ""
        const review: MeetingReview = {
          status: "ready",
          draft,
          expiresInMinutes: 15,
          workspace: w.name,
          title: input.title,
          date: input.date,
          start: input.startTime,
          end: endTime,
          timeZone: clock.timeZone,
          organizer: "you",
          attendees: named(attendees),
          location: input.location || null,
          agenda: input.notes || null,
          clashes,
          past,
          warnings,
          spokenSummary: `${sentence}${caution} Shall I create it?`,
          next: CONFIRM("create_meeting"),
        }
        return okCard(
          `${sentence}${caution} Waiting for the person to confirm.`,
          review,
          await cardView(env, w, "meeting", attendees),
        )
      }),
  )

  server.registerTool(
    "create_meeting",
    {
      title: "Create the reviewed meeting",
      description:
        "Step 2: create the meeting from a review_meeting `draft`, only after the person confirmed that review. Attendees are invited as usual. Administrators only.",
      inputSchema: z.object({ workspace: WORKSPACE, draft: z.string().max(100) }),
      annotations: ADDITIVE,
      ...WRITE,
    },
    async ({ workspace, draft }) =>
      inWorkspace(env, workspace, async (w) => {
        if (w.role !== "administrator") return fail(notAdmin(w, "schedule meetings"), "not_admin")
        const input = await takeDraft<MeetingInput>(ctx, { id: draft, userId: caller.userId, accountId: w.id, kind: "meeting" })
        if (!input) return fail(expired("review_meeting"), "expired")
        const meeting = await createMeeting(ctx, w.id, input)
        const nameOf = await namesIn(ctx, w.id)
        return ok(`Created "${meeting.title}" on ${longDate(meeting.date)}, ${meeting.startTime}–${meeting.endTime}.`, {
          meeting: {
            id: meeting.id,
            title: meeting.title,
            date: meeting.date,
            start: meeting.startTime,
            end: meeting.endTime,
            location: meeting.location || null,
            attendees: meeting.attendeeIds.map(nameOf),
            link: link.meeting(w.id, meeting.id, meeting.date),
          },
        })
      }),
  )
}
