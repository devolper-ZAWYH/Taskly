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
  /** Invited by email and hasn't chosen a password yet. */
  invitePending: boolean
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
  /** IANA zone its meeting times are in (for Google Calendar), or null: each organiser's own. */
  timeZone: string | null
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

/** Someone with an account, invited to a workspace; they join when they accept. */
export type WorkspaceInvitation = {
  id: string
  userId: string
  name: string
  email: string
  avatarUrl: string | null
  role: Role
  invitedBy: string | null
  createdAt: string
}

/** An invitation waiting for the signed-in person (the workspaces page). */
export type MyInvitation = {
  id: string
  account: Pick<Account, "id" | "name" | "logoUrl">
  role: Role
  invitedBy: string | null
  createdAt: string
}

/** A workspace the signed-in user can open, with their effective role there. */
export type MyWorkspace = { account: Account; role: Role; viaOperator: boolean }

export type TaskStatus = "open" | "in_progress" | "on_hold" | "completed" | "cancelled"

export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent"

export type Task = {
  id: string
  accountId: string
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
  /** Only its creator (its sole assignee) can see it, administrators included. */
  private: boolean
  /** Private tasks: copied to the owner's Google Tasks. */
  googleSync: boolean
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

/** A machine translation of one field (Arabic ↔ English). */
export type FieldTranslation = {
  /** The language it was written in. */
  from: "en" | "ar"
  /** The language of `text`. */
  lang: "en" | "ar"
  text: string
  status: "pending" | "done" | "failed"
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
  /** Title and agenda in the other language (set when reading one meeting). */
  translations?: { title?: FieldTranslation; notes?: FieldTranslation }
}

/**
 * Who can read a set of minutes besides its author: nobody, everyone in the
 * workspace, or the people it's shared with.
 */
export const MINUTES_VISIBILITIES = ["private", "workspace", "people"] as const
export type MinutesVisibility = (typeof MINUTES_VISIBILITIES)[number]

/** One person's minutes of a meeting. Only the author edits them. */
export type MeetingMinutes = {
  id: string
  accountId: string
  /** Null once the meeting was deleted (the minutes stay). */
  meetingId: string | null
  /** The meeting's current title and date (as last known if it was deleted). */
  meetingTitle: string
  meetingDate: string
  /** The reader can open the meeting itself (minutes can be shared with people who weren't invited). */
  meetingVisible: boolean
  authorId: string
  body: string
  visibility: MinutesVisibility
  /** Who it's shared with when `visibility` is "people". */
  sharedWithIds: string[]
  createdAt: string
  updatedAt: string
}

/** What the author edits. */
export type MinutesInput = {
  body: string
  visibility: MinutesVisibility
  sharedWithIds: string[]
}

/** Minutes page tabs: everything you can read, yours, or other people's shared with you. */
export const MINUTES_SCOPES = ["all", "mine", "shared"] as const
export type MinutesScope = (typeof MINUTES_SCOPES)[number]

/**
 * Task list tabs. `mine`: your private tasks. `assigned`: workspace tasks
 * assigned to you. `all` (administrators): every workspace task. `completed`:
 * closed ones you can see.
 */
export type TaskScope = "mine" | "assigned" | "all" | "completed"

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
  /** On create: just for its creator. Members can only create private tasks. */
  private?: boolean
  /** Private tasks: copy it to the owner's Google Tasks. */
  googleSync?: boolean
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
  /** Null when they already had an account: they were invited and join on accepting. */
  member: WorkspaceMember | null
  /** Set instead of `member` for someone who already had an account. */
  invitation: WorkspaceInvitation | null
  /** A new account was emailed a link to set their password. */
  invited: boolean
  /**
   * Set when a new account was created and couldn't be invited by email (email
   * isn't set up, or sending failed): share it once; they can change it in Settings.
   */
  temporaryPassword: string | null
}

/** Administrators can only change a member's role. */
export type UpdateMemberInput = { role: Role }

export type AccountSummary = Account & { memberCount: number }

export type UserSummary = PublicUser & {
  /** Their confirmed addresses besides the primary one. */
  otherEmails: string[]
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
  "minutes_shared",
  "workspace_added",
  "google_sync",
] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export type NotificationChannel = "inApp" | "push" | "email"

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
  /** Their sync jobs that stopped retrying; "Sync now" tries them again. */
  failedJobs: number
}

/** A sync job that failed at least once (operator console). */
export type GoogleSyncJobProblem = {
  id: string
  kind: string
  workspace: string | null
  person: string | null
  /** The title of the task or meeting it was about, if any. */
  item: string | null
  attempts: number
  error: string | null
  /** Set once it stopped retrying. */
  failedAt: string | null
  nextAttemptAt: string
}

/** Someone whose Google connection needs them to reconnect (operator console). */
export type GoogleConnectionProblem = {
  userId: string
  name: string
  email: string
  state: "revoked" | "error"
  error: string | null
  since: string
}

/** How Google sync is doing across the platform (operator console). */
export type GoogleSyncHealth = {
  configured: boolean
  connections: number
  /** Jobs that stopped retrying. */
  failed: number
  /** Jobs that failed but will try again. */
  retrying: number
  /** Jobs waiting for their first run. */
  queued: number
  jobs: GoogleSyncJobProblem[]
  people: GoogleConnectionProblem[]
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

/** Where a group of deployment settings comes from (Platform → Settings). */
export type SettingSource = "console" | "environment" | "unset"

/** Deployment settings as operators see them. Secrets are never sent back, only whether they're set. */
export type PlatformSettings = {
  /** ENCRYPTION_KEY is set, so secrets can be saved here. */
  encryptionReady: boolean
  app: { source: SettingSource; origin: string }
  mail: {
    source: SettingSource
    host: string
    port: number
    secure: boolean
    user: string
    from: string
    passwordSet: boolean
    ready: boolean
  }
  google: {
    source: SettingSource
    clientId: string
    secretSet: boolean
    /** Add this to the OAuth client's authorised redirect URIs. */
    redirectUri: string
    ready: boolean
  }
  push: { source: SettingSource; publicKey: string; ready: boolean; devices: number }
  translation: {
    source: SettingSource
    /** "" when translation is off. */
    provider: string
    keySet: boolean
    keyId: string
    region: string
    model: string
    ready: boolean
  }
  live: {
    source: SettingSource
    /** "" reads as the default `on_device` (the engine writes its own draft). */
    provider: string
    keySet: boolean
    baseUrl: string
    model: string
    ready: boolean
  }
}

/** One group to save. An empty secret keeps the current one. */
export type PlatformSettingsInput =
  | { group: "app"; origin: string }
  | {
      group: "mail"
      host: string
      port: number
      secure: boolean
      user: string
      from: string
      password: string
    }
  | { group: "google"; clientId: string; clientSecret: string }
  | {
      group: "translation"
      /** "" turns translation off. */
      provider: string
      key: string
      keyId: string
      region: string
      model: string
    }
  | {
      group: "live"
      /** The summary provider; the default is `on_device` (the engine's own). */
      provider: string
      key: string
      baseUrl: string
      model: string
    }

/** The signed-in person's email addresses (Settings → Email addresses). */
export type MyEmails = {
  /** Sign-in default and the address for workspaces that don't pick another. */
  primary: string
  others: { email: string; confirmed: boolean; workspaces: string[] }[]
  /** Each workspace they belong to and the address it knows them by. */
  workspaces: { accountId: string; name: string; email: string }[]
}

// ---- Live meetings ---------------------------------------------------------

/** Who spoke: the device's microphone ("Me") or the meeting app's loopback ("Them"). */
export const LIVE_SOURCES = ["mic", "system"] as const
export type LiveSource = (typeof LIVE_SOURCES)[number]

/** A recording's lifecycle: capturing → reviewing → (review card, later phase) done. */
export const LIVE_SESSION_STATUSES = ["capturing", "reviewing", "done", "aborted"] as const
export type LiveSessionStatus = (typeof LIVE_SESSION_STATUSES)[number]

/** One recording on a meeting (or ad-hoc), by one person. */
export type LiveSession = {
  id: string
  accountId: string
  /** Null when the device couldn't claim a meeting, with its title/date snapshots. */
  meetingId: string | null
  meetingTitle: string
  meetingDate: string
  /** The recorder. Reads by others follow the meeting's visibility rules. */
  recorderId: string
  status: LiveSessionStatus
  startedAt: string
  endedAt: string | null
  lastSeenAt: string | null
}

/** One segment: what one person said, as spoken and (from the device) in English and Arabic. */
export type LiveSegment = {
  id: string
  sessionId: string
  /** 1, 2, 3… per session; the idempotent push key and the read cursor. */
  seq: number
  source: LiveSource
  /** As spoken (e.g. "ar", "en"), when the device knows. */
  lang: string | null
  text: string
  textEn: string | null
  /** The Arabic line; null from engines that only translate into English. */
  textAr: string | null
  /** Milliseconds from the session start, as the device clocked them. */
  startedAtMs: number | null
  endedAtMs: number | null
  createdAt: string
}

/** A transcript read: the session plus the segments beyond the cursor. */
export type LiveTranscript = { session: LiveSession; segments: LiveSegment[] }

/** A device token as Settings shows it; the raw token itself is never stored. */
export type LiveDeviceToken = {
  id: string
  name: string
  accountId: string
  /** The workspace's name (tokens are per user and workspace). */
  workspace: string
  lastUsed: string
  createdAt: string
}

/** The raw token, returned exactly once at creation. */
export type LiveDeviceTokenSecret = { token: string; device: LiveDeviceToken }

/** One proposed action item of a live draft (camelCase; the wire sends `action_items`). */
export type LiveDraftActionItem = {
  title: string
  /**
   * A person's name as the summarizer heard it. Never trusted as a member:
   * matched on accept (`server/mcp/match.ts`), and an unclear name creates the
   * task unassigned with the name in its description instead.
   */
  assignee?: string
  /** `YYYY-MM-DD`, unset (or "") when there is none. */
  due?: string
}

/** The review draft's fixed sections (docs/live-meetings.md §5), camelCase. */
export type LiveDraftPayload = {
  sections: {
    summary: string
    decisions: string[]
    followUps: string[]
  }
  actionItems: LiveDraftActionItem[]
}

/** A review draft as the card reads it: live for 15 minutes, single-use. */
export type LiveDraft = {
  id: string
  sessionId: string
  /** ISO time after which the draft refuses to be consumed. */
  expiresAt: string
  sections: LiveDraftPayload["sections"]
  actionItems: LiveDraftActionItem[]
}

/** `liveAccept`: what the review card sends. `items` runs in the draft's item order. */
export type LiveAcceptInput = {
  sessionId: string
  /** The draft the card shows; a newer one in between answers `liveDraftGone`. */
  draftId?: string
  visibility: MinutesVisibility
  /** With `people`: the readers (active members, the minutes rule). */
  sharedWithIds?: string[]
  /** A line the reviewer adds to the end of the minutes' body. */
  note?: string
  /** Assignee/due edits from the card; `assigneeId` is a member id, `null` clears. */
  items?: { assigneeId?: string | null; due?: string | null }[]
}

/** What `liveAccept` created. */
export type LiveAcceptResult = { minutes: MeetingMinutes; tasks: Task[] }

// ---- Claude connector ------------------------------------------------------

/** An app asking for access, as the consent screen shows it, or where to send the person back to. */
export type ConsentRequest =
  | {
      kind: "consent"
      /** `name` is what the app calls itself; `host` is where it really lives. */
      app: { name: string; host: string; local: boolean }
      /** Where the person is sent after answering. */
      redirectHost: string
      scopes: string[]
    }
  | { kind: "redirect"; redirectUrl: string }

/** One app connected to the person's Taskly account. */
export type ClaudeConnection = {
  id: string
  app: string
  host: string
  /** Runs on their own computer (e.g. Claude Code). */
  local: boolean
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
}

/** Settings → Set up MCP. */
export type ClaudeSetup = {
  /** This Taskly has an App address the connector can use. */
  available: boolean
  /** https: the Claude apps can connect (localhost only works with Claude Code). */
  publicUrl: boolean
  connectorUrl: string | null
  workspaces: { id: string; name: string; role: Role }[]
  connections: ClaudeConnection[]
}
