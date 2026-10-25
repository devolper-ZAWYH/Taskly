/**
 * The accept-time rules of the live review (docs/live-meetings.md §6), kept
 * free of the database like server/live/push.ts so tests run them directly.
 * The service (server/services/live.ts) matches names with server/mcp/match.ts,
 * then plans each action item here and writes it with the tasks service.
 */
import { AppError } from "@/lib/api/core"
import type {
  LiveDraftActionItem,
  LiveDraftPayload,
  Locale,
  MinutesVisibility,
  Role,
  TaskInput,
} from "@/lib/types"
import { str } from "@/server/validate"
import type { Match } from "@/server/mcp/match"

/** What the review card may edit per action item (same order as the draft's). */
export type AcceptItemOverride = { assigneeId?: string | null; due?: string | null }

const bad = (): never => {
  throw new AppError("badRequest")
}

/** Validate the card's `items` exactly as the contract says: cap, shape, dates. */
export function parseAcceptItems(value: unknown, max: number): AcceptItemOverride[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) bad()
  return (value as unknown[]).map((item) => {
    if (item === undefined || item === null) return {} as AcceptItemOverride
    if (typeof item !== "object" || Array.isArray(item)) bad()
    const one = item as Record<string, unknown>
    const override: AcceptItemOverride = {}
    if (one.assigneeId !== undefined) {
      // null explicitly clears the draft's name; a string is a member id.
      override.assigneeId = one.assigneeId === null ? null : str(one.assigneeId, 100)
    }
    if (one.due !== undefined) {
      // null clears the draft's date; a string must be YYYY-MM-DD.
      override.due =
        one.due === null
          ? null
          : (function () {
              const v = String(one.due)
              if (v.length > 10 || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad()
              return v
            })()
    }
    return override
  })
}

const assigneeNote = (name: string, why: "unmatched" | "ambiguous" | "member") =>
  why === "member"
    ? `Assignee not set: ${name} (assigning others needs an administrator).`
    : why === "ambiguous"
      ? `Assignee not set: "${name}" fits several people in the workspace.`
      : `Assignee not set: "${name}" doesn't match anyone in the workspace.`

/**
 * Turn one accepted action item into the task that gets written. Never guesses:
 * an unclear name, a name that isn't the actor's (when the actor is a member),
 * or a member's card override of someone else all leave the task unassigned
 * and note why in its description — an administrator fixes the assignee
 * afterwards. Administrators assign anyone (the delegate rule). A member's
 * item that would end up with nobody becomes their own private task instead:
 * an unassigned workspace task is invisible to members (lib/permissions.ts
 * `canViewTask`), so it would vanish from the very person who accepted it.
 */
export function planActionTask(args: {
  actorId: string
  actorRole: Role
  item: LiveDraftActionItem
  override?: AcceptItemOverride
  /** match.ts's verdict for the item's own name (found / ambiguous / missing). */
  resolved: Match | null
  meetingId: string | null
}): { input: TaskInput; note: string | null } {
  const { actorId, actorRole, item, override, resolved, meetingId } = args
  const assigneeIds: string[] = []
  const notes: string[] = []
  const addAssignee = (id: string) => assigneeIds.push(id)
  const memberOnlySelf = actorRole !== "administrator"

  if (override?.assigneeId !== undefined) {
    // The card picked a specific member; that's an explicit choice, not a guess.
    if (override.assigneeId !== null) {
      if (memberOnlySelf && override.assigneeId !== actorId) {
        notes.push(assigneeNote("another person", "member"))
      } else {
        addAssignee(override.assigneeId)
      }
    }
  } else if (item.assignee) {
    // The draft only carries a NAME from the transcript (never an id).
    // `resolved` is null only when there is no name to match at all.
    const verdict = resolved ?? { kind: "missing" as const, query: item.assignee }
    if (verdict.kind === "found") {
      if (!memberOnlySelf || verdict.person.id === actorId) {
        addAssignee(verdict.person.id)
        if (verdict.quality === "similar") {
          notes.push(`Checked "as heard" the name "${item.assignee}", assigned to ${verdict.person.name}.`)
        }
      } else {
        notes.push(assigneeNote(verdict.person.name, "member"))
      }
    } else if (verdict.kind === "ambiguous") {
      notes.push(assigneeNote(item.assignee, "ambiguous"))
    } else {
      notes.push(assigneeNote(item.assignee, "unmatched"))
    }
  }

  const dueDate = override?.due === undefined ? (item.due ?? "") : (override.due ?? "")
  const keepPrivate = memberOnlySelf && assigneeIds.length === 0
  const input: TaskInput = {
    title: item.title,
    description: notes.join(" "),
    status: "open",
    priority: "none",
    startDate: "",
    startTime: "",
    dueDate,
    dueTime: "",
    // A private task's only assignee is its creator (the tasks rule).
    assigneeIds: keepPrivate ? [actorId] : assigneeIds,
    meetingId,
    private: keepPrivate,
    googleSync: false,
  }
  return { input, note: notes.length > 0 ? notes.join(" ") : null }
}

/**
 * Who may read the accepted minutes on the review card: private always;
 * workspace and people only for administrators — a stricter rule than
 * hand-typed minutes, because this body was written by an engine (docs/
 * live-meetings.md §4). The service-level share rules still apply for `people`.
 */
export function assertAcceptVisibility(role: Role, visibility: MinutesVisibility): void {
  if (visibility !== "private" && role !== "administrator") throw new AppError("forbidden")
}

const HEADINGS: Record<Locale, { decisions: string; followUps: string; notes: string }> = {
  en: { decisions: "Decisions", followUps: "Follow-ups", notes: "Notes" },
  ar: { decisions: "القرارات", followUps: "نقاط متابعة", notes: "ملاحظات" },
}

/** A list section, present only when it has items. */
function section(heading: string, items: string[]): string {
  if (items.length === 0) return ""
  return [heading, ...items.map((item) => `- ${item}`)].join("\n")
}

/**
 * The minutes' body, plain text that renders like hand-typed minutes
 * (whitespace preserved, no markdown): the summary, then the decisions and
 * follow-ups as lists, then the reviewer's optional note.
 */
export function composeMinutesBody(
  payload: LiveDraftPayload,
  locale: Locale,
  note?: string,
): string {
  const labels = HEADINGS[locale]
  const parts = [payload.sections.summary.trim()]
  const decisions = section(labels.decisions, payload.sections.decisions)
  if (decisions) parts.push(decisions)
  const followUps = section(labels.followUps, payload.sections.followUps)
  if (followUps) parts.push(followUps)
  const trimmed = (note ?? "").trim()
  if (trimmed) parts.push(section(labels.notes, [trimmed]))
  return parts.filter((part) => part).join("\n\n").trim()
}
