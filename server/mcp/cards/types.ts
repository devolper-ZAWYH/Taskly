/**
 * What Claude's interactive cards read from tool results (`structuredContent`),
 * shared by the tools that send it and the card code (./view) that shows it.
 * Claude reads the same data as text, except `view`, which is for the card.
 */
import type { Role, TaskPriority, TaskStatus } from "@/lib/types"

export type CardKind = "delegation" | "meeting" | "outcome" | "my_day" | "choose_meeting" | "choose_people"

/** Card-only details, kept out of the text Claude reads. */
export type CardView = {
  card: CardKind
  locale: "en" | "ar"
  workspaceId: string
  /** Profile photo per person id, for people who have one (server/mcp/photos.ts). */
  photos: Record<string, string>
}

export type PersonRef = { id: string; name: string; email: string }

/** A matched person; `understoodFrom` is what was said when the match was only similar. */
export type NamedPerson = PersonRef & { understoodFrom: string | null }

/** Names that fit several people, or nobody: nothing was drafted. */
export type NeedsChoice = {
  status: "needs_choice"
  workspace: string
  choices: { query: string; candidates: PersonRef[] }[]
  missing: string[]
  next: string
}

export type DelegationReview = {
  status: "ready"
  draft: string
  expiresInMinutes: number
  workspace: string
  title: string
  assignees: NamedPerson[]
  /** "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". */
  due: string | null
  pastDue: boolean
  priority: TaskPriority
  meeting: { id: string; title: string } | null
  warnings: string[]
  spokenSummary: string
  next: string
}

export type Clash = { personId: string; person: string; meeting: string; time: string }

export type MeetingReview = {
  status: "ready"
  draft: string
  expiresInMinutes: number
  workspace: string
  title: string
  date: string
  start: string
  end: string
  timeZone: string
  organizer: "you"
  attendees: NamedPerson[]
  location: string | null
  agenda: string | null
  clashes: Clash[]
  past: boolean
  warnings: string[]
  spokenSummary: string
  next: string
}

/** Who may read minutes, as a review shows it. */
export type MinutesReaders =
  | { kind: "private" }
  | { kind: "workspace" }
  | { kind: "people"; people: NamedPerson[] }

/**
 * Everything from one meeting in a single review: its minutes, tasks for the
 * team, the person's own tasks, and the next meeting. Each part has a `key`;
 * the person can leave parts out (`skip`) when creating.
 */
export type OutcomeReview = {
  status: "ready"
  draft: string
  expiresInMinutes: number
  workspace: string
  meeting: { id: string; title: string; date: string }
  minutes: { key: "minutes"; body: string; readers: MinutesReaders; replaces: boolean } | null
  tasks: {
    key: string
    title: string
    assignees: NamedPerson[]
    due: string | null
    pastDue: boolean
    priority: TaskPriority
  }[]
  myTasks: { key: string; title: string; due: string | null; pastDue: boolean; priority: TaskPriority }[]
  nextMeeting: {
    key: "next_meeting"
    title: string
    date: string
    start: string
    end: string
    timeZone: string
    attendees: NamedPerson[]
    location: string | null
    agenda: string | null
    clashes: Clash[]
    past: boolean
  } | null
  warnings: string[]
  spokenSummary: string
  next: string
}

/** What create_meeting_outcome made, part by part. */
export type OutcomeResult = {
  created: { key: string; kind: "minutes" | "task" | "my_task" | "meeting"; title: string; link: string }[]
  failed: { key: string; title: string; error: string }[]
  skipped: string[]
}

export type DayMeeting = {
  id: string
  title: string
  start: string
  end: string
  location: string | null
  link: string
}

export type DayTask = {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  due: string | null
  overdue: boolean
  link: string
}

export type MyDay = {
  workspace: string
  today: string
  timeZone: string
  meetings: DayMeeting[]
  tasks: DayTask[]
  /** Due today or overdue but not listed. */
  moreTasks: number
  tasksLink: string
  calendarLink: string
}

export type MeetingChoice = {
  id: string
  title: string
  date: string
  start: string
  end: string
  location: string | null
  attendees: number
  hasMyMinutes: boolean
}

export type MeetingChoices = {
  workspace: string
  today: string
  meetings: MeetingChoice[]
  total: number
  next: string
}

export type PeopleChoices = {
  workspace: string
  multiple: boolean
  people: (PersonRef & { role: Role })[]
  /** Ids ticked to start with. */
  selected: string[]
  next: string
}

/** What a card result may hold. */
export type CardData = (
  | NeedsChoice
  | DelegationReview
  | MeetingReview
  | OutcomeReview
  | MyDay
  | MeetingChoices
  | PeopleChoices
) & { view?: CardView }
