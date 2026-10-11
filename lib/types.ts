export type Role = "administrator" | "member"

export type Locale = "en" | "ar"

export type User = {
  id: string
  name: string
  email: string
  /** Platform operator: manages accounts and users; may enter any workspace. */
  isOperator: boolean
  /** Platform-wide switch; inactive users can't sign in anywhere. */
  active: boolean
  locale: Locale
  createdAt: string
  /** Versioned URL of their profile picture, or null for initials. */
  avatarUrl: string | null
  /** IANA time zone reported by their browser (for reminders), or null. */
  timeZone: string | null
  /** How the calendar opens on a phone. */
  calendarView: CalendarPreference
}

export const CALENDAR_PREFERENCES = ["calendar", "list"] as const
/** "calendar" = month grid, "list" = day-by-day list. */
export type CalendarPreference = (typeof CALENDAR_PREFERENCES)[number]

/** A user as the browser sees it (the server never sends password hashes). */
export type PublicUser = User

/** A workspace (tenant). */
export type Account = {
  id: string
  name: string
  active: boolean
  createdAt: string
  /** Versioned URL of the workspace logo, or null for the default brand. */
  logoUrl: string | null
}

/** Logo formats a workspace can upload. */
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const
export type LogoType = (typeof LOGO_TYPES)[number]
export const MAX_LOGO_BYTES = 512 * 1024

/** Profile pictures are resized in the browser to a small square first. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const
export type AvatarType = (typeof AVATAR_TYPES)[number]
export const MAX_AVATAR_BYTES = 256 * 1024
export const AVATAR_SIZE = 256

/** A user's membership in a workspace; the role is per workspace. */
export type Membership = {
  id: string
  accountId: string
  userId: string
  role: Role
  createdAt: string
}

/** A workspace member as seen inside that workspace. */
export type WorkspaceMember = PublicUser & { role: Role; membershipId: string }

/** A workspace the signed-in user can open, with their effective role there. */
export type MyWorkspace = { account: Account; role: Role; viaOperator: boolean }

export type TaskStatus = "open" | "in_progress" | "on_hold" | "completed" | "cancelled"

export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent"

export type Task = {
  id: string
  accountId: string
  /** Display number, unique within the workspace (T-n). */
  number: number
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  /** `YYYY-MM-DD` or "" */
  startDate: string
  /** `HH:MM` or "" (date-only when empty) */
  startTime: string
  dueDate: string
  dueTime: string
  assigneeIds: string[]
  createdById: string | null
  /** Meeting this task was created from (an "action item"), if any. */
  meetingId: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Meeting = {
  id: string
  accountId: string
  title: string
  notes: string
  /** `YYYY-MM-DD` */
  date: string
  /** `HH:MM` */
  startTime: string
  endTime: string
  /** Room name or a call link */
  location: string
  attendeeIds: string[]
  organizerId: string
  createdAt: string
  updatedAt: string
}

/** Task list tabs: members see `assigned`; administrators see `all`; both see `completed`. */
export type TaskScope = "assigned" | "completed" | "all"

export type DueFilter = "overdue" | "today" | "week" | "none"

/** Optional narrowing of a task list (administrators' filter bar). */
export type TaskFilters = {
  status?: TaskStatus
  priority?: TaskPriority
  /** A member's id, or "none" for unassigned tasks. */
  assigneeId?: string
  due?: DueFilter
  /** The viewer's today (YYYY-MM-DD), so "overdue"/"today" follow their clock. */
  today?: string
}

export type Page<T> = { items: T[]; total: number }

/** Fields a person edits on a task. */
export type TaskInput = {
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  startDate: string
  startTime: string
  dueDate: string
  dueTime: string
  assigneeIds: string[]
  /** Set when the task is created as an action item of a meeting. */
  meetingId?: string | null
}

export type MeetingInput = {
  title: string
  notes: string
  date: string
  startTime: string
  endTime: string
  location: string
  attendeeIds: string[]
}

/** Add someone by email: an existing sign-in joins, a new email gets an account. */
export type AddMemberInput = { email: string; role: Role }

export type AddMemberResult = {
  member: WorkspaceMember
  /** Set when a new account was created: share it once; they can change it in Settings. */
  temporaryPassword: string | null
}

/** Administrators can only change a member's role. */
export type UpdateMemberInput = { role: Role }

export type AccountSummary = Account & { memberCount: number }

export type UserSummary = PublicUser & {
  workspaces: { membershipId: string; accountId: string; accountName: string; role: Role }[]
}

/** A meeting as offered in the task form's "Related to" picker. */
export type MeetingOption = Pick<Meeting, "id" | "title" | "date" | "startTime">

/** Notification preference groups a person can switch per channel. */
export const NOTIFICATION_KINDS = [
  "task_assigned",
  "task_updated",
  "task_reminders",
  "meeting_invited",
  "meeting_changed",
  "workspace_added",
  "google_sync",
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export type NotificationChannel = "inApp" | "push"

export type NotificationPrefs = Record<NotificationKind, Record<NotificationChannel, boolean>>

/** A notification as shown to its recipient (text already in their language). */
export type AppNotification = {
  id: string
  text: string
  link: string | null
  workspace: string | null
  read: boolean
  createdAt: string
}

/** Open work for one workspace member (administrators' dashboard). */
export type PersonLoad = { user: WorkspaceMember; open: number; overdue: number }

/** Everything the dashboard shows, in one request. `team` is for administrators. */
export type Dashboard = {
  /** The caller's local date the numbers were computed for (YYYY-MM-DD). */
  today: string
  mine: {
    overdue: Task[]
    dueToday: Task[]
    upcoming: Task[]
  }
  /** Visible meetings from today through the next 7 days. */
  meetings: Meeting[]
  team: {
    overdue: number
    unassigned: number
    dueThisWeek: number
    completedThisWeek: number
    createdThisWeek: number
    people: PersonLoad[]
    unassignedTasks: Task[]
  } | null
}

// ---- Google sync -----------------------------------------------------------

/** A person's Google connection, as Settings shows it. */
export type GoogleStatus = {
  /** The server has OAuth credentials; without them there is nothing to connect. */
  configured: boolean
  connected: boolean
  /** The connected Google account's email. */
  email: string | null
  /** "revoked": Google refused the saved access, so the person must reconnect. */
  state: "active" | "revoked" | "error" | null
  lastError: string | null
  /** Last time anything synced for this person (ISO), or null. */
  lastSyncAt: string | null
}

export type GoogleContainerKind = "tasklist" | "calendar"

/** One of the person's Google task lists or calendars. */
export type GoogleContainer = {
  kind: GoogleContainerKind
  id: string
  title: string
  /** Set for the "Taskly · <Workspace>" list/calendar Taskly manages (always synced). */
  accountId: string | null
  /** Personal containers: whether their items show in Taskly. */
  selected: boolean
  /** Google's colour for the calendar (hex), if any. */
  color: string | null
  /** The person's default task list / primary calendar. */
  primary: boolean
}

/** One of the person's own Google Tasks. Only they see it in Taskly. */
export type PersonalTask = {
  id: string
  tasklistId: string
  tasklistTitle: string
  title: string
  notes: string
  /** `YYYY-MM-DD` or "" (Google Tasks has no due time). */
  dueDate: string
  completed: boolean
  completedAt: string | null
  updatedAt: string
  /** Opens the task in Google, when Google provides a link. */
  webLink: string | null
}

export type PersonalTaskInput = {
  title: string
  notes: string
  dueDate: string
  completed: boolean
}

/** One occurrence of an event on the person's own Google calendars. */
export type PersonalEvent = {
  id: string
  calendarId: string
  calendarTitle: string
  color: string | null
  title: string
  description: string
  location: string
  allDay: boolean
  /** Timed: RFC 3339 instants. All-day: `YYYY-MM-DD`, with `end` exclusive (Google's convention). */
  start: string
  end: string
  /** Part of a repeating series; edits from Taskly change this occurrence only. */
  recurring: boolean
  /** False when someone else organises it and guests can't modify it. */
  editable: boolean
  htmlLink: string | null
}

/** Times are wall-clock in `timeZone` (the browser's zone). */
export type PersonalEventInput = {
  title: string
  description: string
  location: string
  date: string
  /** `HH:MM`; ignored when `allDay`. */
  startTime: string
  endTime: string
  allDay: boolean
  timeZone: string
}
