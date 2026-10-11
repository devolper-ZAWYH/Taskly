import type {
  Account,
  Meeting,
  Membership,
  Task,
  TaskPriority,
  TaskStatus,
  User,
} from "@/lib/types"

/** Seed people carry a plain password; the seed script hashes it. */
export type SeedUser = Omit<User, "avatarUrl" | "timeZone" | "calendarView" | "invitePending"> & {
  password: string
}

export const DEMO_ADMIN = { email: "admin@example.com", password: "admin1234" }
export const DEMO_MEMBER = { email: "omar@example.com", password: "member1234" }
export const DEMO_OPERATOR = { email: "operator@example.com", password: "operator1234" }

export const ACME = "acc-acme"
export const NORTHWIND = "acc-northwind"

function isoDay(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

const now = new Date().toISOString()

export const OPERATOR_USER: SeedUser = {
  id: "u-operator",
  name: "Platform Operator",
  email: DEMO_OPERATOR.email,
  password: DEMO_OPERATOR.password,
  isOperator: true,
  active: true,
  locale: "en",
  createdAt: now,
}

export const SEED_USERS: SeedUser[] = [
  OPERATOR_USER,
  {
    id: "u-admin",
    name: "Aisha Al-Thani",
    email: DEMO_ADMIN.email,
    password: DEMO_ADMIN.password,
    isOperator: false,
    active: true,
    locale: "en",
    createdAt: now,
  },
  {
    id: "u-omar",
    name: "Omar Haddad",
    email: DEMO_MEMBER.email,
    password: DEMO_MEMBER.password,
    isOperator: false,
    active: true,
    locale: "en",
    createdAt: now,
  },
  {
    id: "u-sara",
    name: "Sara Mansour",
    email: "sara@example.com",
    password: "member1234",
    isOperator: false,
    active: true,
    locale: "ar",
    createdAt: now,
  },
  {
    id: "u-daniel",
    name: "Daniel Reyes",
    email: "daniel@example.com",
    password: "member1234",
    isOperator: false,
    active: true,
    locale: "en",
    createdAt: now,
  },
]

type SeedRow = [
  title: string,
  status: TaskStatus,
  priority: TaskPriority,
  due: number | null,
  dueTime: string,
  assignees: string[],
  creator: string,
  description?: string,
]

const ROWS: SeedRow[] = [
  [
    "Prepare company registration file for Al Noor Trading",
    "in_progress",
    "high",
    2,
    "10:00",
    ["u-omar"],
    "u-admin",
    "Collect passport copies, lease agreement and registration forms for the new client.",
  ],
  [
    "Book introduction meeting with the free-zone authority",
    "open",
    "medium",
    5,
    "",
    ["u-sara"],
    "u-admin",
  ],
  ["Draft spring mentorship schedule", "open", "medium", 9, "", ["u-sara", "u-daniel"], "u-admin"],
  [
    "Review brand guidelines for City Bakers",
    "on_hold",
    "low",
    14,
    "",
    ["u-daniel"],
    "u-omar",
    "Waiting on the client's final logo files.",
  ],
  ["Website copy — Arabic translation pass", "in_progress", "high", 1, "", ["u-sara"], "u-admin"],
  [
    "Follow up with landlord on office fit-out",
    "open",
    "urgent",
    0,
    "14:30",
    ["u-omar"],
    "u-admin",
  ],
  [
    "Prepare onboarding pack for new SME clients",
    "open",
    "medium",
    12,
    "",
    ["u-daniel", "u-omar"],
    "u-admin",
  ],
  ["Quarterly partner report", "open", "high", 6, "", ["u-admin"], "u-admin"],
  ["Shortlist venues for founders' breakfast", "open", "low", 20, "", ["u-sara"], "u-sara"],
  ["Collect testimonials from Q3 clients", "open", "none", null, "", ["u-daniel"], "u-admin"],
  [
    "Trade licence renewal — Gulf Ventures",
    "in_progress",
    "urgent",
    -1,
    "",
    ["u-omar"],
    "u-admin",
    "Licence expires this week. Coordinate with the client's PRO.",
  ],
  ["Update service pricing sheet", "open", "medium", 8, "", ["u-admin", "u-daniel"], "u-admin"],
  ["Research incentives for foreign tech startups", "open", "medium", 15, "", ["u-sara"], "u-omar"],
  [
    "Set up shared drive structure for client files",
    "on_hold",
    "low",
    null,
    "",
    ["u-daniel"],
    "u-admin",
  ],
  ["Plan demo day logistics", "open", "high", 25, "", ["u-sara", "u-omar"], "u-admin"],
  ["Market entry memo — UK fintech client", "in_progress", "high", 4, "", ["u-omar"], "u-admin"],
  ["Renew company insurance policy", "open", "medium", 30, "", ["u-admin"], "u-admin"],
  ["Arrange bank account opening appointment", "open", "high", 3, "09:30", ["u-omar"], "u-sara"],
  ["Refresh LinkedIn company page", "open", "low", null, "", ["u-daniel"], "u-daniel"],
  [
    "Interview candidates for operations associate",
    "open",
    "medium",
    7,
    "11:00",
    ["u-admin", "u-sara"],
    "u-admin",
  ],
  ["Ministry of Labour quota application", "open", "urgent", 2, "", ["u-omar"], "u-admin"],
  ["Prepare welcome kit for the new cohort", "open", "low", 18, "", ["u-sara"], "u-sara"],
  ["Sign NDA with logistics partner", "completed", "medium", -6, "", ["u-admin"], "u-admin"],
  ["Submit Q2 VAT documentation", "completed", "high", -12, "", ["u-daniel"], "u-admin"],
  ["Launch new website homepage", "completed", "high", -20, "", ["u-sara", "u-daniel"], "u-admin"],
  ["Client kick-off — Al Noor Trading", "completed", "medium", -9, "", ["u-omar"], "u-admin"],
  ["Photograph the new office", "completed", "low", -15, "", ["u-daniel"], "u-daniel"],
  [
    "Office opening event",
    "cancelled",
    "medium",
    -3,
    "",
    ["u-sara"],
    "u-admin",
    "Postponed to next quarter.",
  ],
  ["Print brochures (English)", "completed", "low", -25, "", ["u-omar"], "u-omar"],
  ["Translate service catalogue to Arabic", "completed", "medium", -4, "", ["u-sara"], "u-admin"],
]

/** Private tasks: [title, priority, due (days from today), owner]. */
const PRIVATE_ROWS: [string, TaskPriority, number | null, string][] = [
  ["Prepare my quarterly self-review", "medium", 5, "u-admin"],
  ["Book dentist appointment", "none", 2, "u-omar"],
  ["Read the new travel policy", "low", null, "u-omar"],
]

export function buildSeedTasks(): Task[] {
  const created = new Date()
  const shared = ROWS.map((row, index): Task => {
    const [title, status, priority, due, dueTime, assigneeIds, creator, description] = row
    const createdAt = new Date(created.getTime() - (ROWS.length - index) * 3_600_000).toISOString()
    return {
      id: `t-${index + 1}`,
      accountId: ACME,
      title,
      description: description ?? "",
      status,
      priority,
      startDate: "",
      startTime: "",
      dueDate: due === null ? "" : isoDay(due),
      dueTime,
      assigneeIds,
      createdById: creator,
      meetingId: TASK_MEETING[index + 1] ?? null,
      private: false,
      googleSync: false,
      completedAt: status === "completed" ? createdAt : null,
      createdAt,
      updatedAt: createdAt,
    }
  })
  const at = created.toISOString()
  const own = PRIVATE_ROWS.map(([title, priority, due, owner], i): Task => ({
    id: `t-p${i + 1}`,
    accountId: ACME,
    title,
    description: "",
    status: "open",
    priority,
    startDate: "",
    startTime: "",
    dueDate: due === null ? "" : isoDay(due),
    dueTime: "",
    assigneeIds: [owner],
    createdById: owner,
    meetingId: null,
    private: true,
    googleSync: false,
    completedAt: null,
    createdAt: at,
    updatedAt: at,
  }))
  return [...shared, ...own]
}

/** `YYYY-MM-DD` for a day in a week relative to the current one (weeks start Sunday). */
function weekDay(weekOffset: number, dayIndex: number): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() + weekOffset * 7 + dayIndex)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

const EVERYONE = ["u-admin", "u-omar", "u-sara", "u-daniel"]

type MeetingRow = [
  id: string,
  title: string,
  week: number,
  day: number,
  start: string,
  end: string,
  location: string,
  attendees: string[],
  organizer: string,
  notes?: string,
]

const MEETINGS: MeetingRow[] = [
  ["m-1", "Weekly team sync", -1, 0, "09:00", "09:45", "Meeting room 1", EVERYONE, "u-admin"],
  [
    "m-2",
    "Hiring panel — operations associate",
    -1,
    2,
    "11:00",
    "12:00",
    "Meeting room 2",
    ["u-admin", "u-sara"],
    "u-admin",
    "Two candidates shortlisted. Decide on next round.",
  ],
  [
    "m-3",
    "Weekly team sync",
    0,
    0,
    "09:00",
    "09:45",
    "Meeting room 1",
    EVERYONE,
    "u-admin",
    "Priorities for the week, blockers, client updates.",
  ],
  [
    "m-4",
    "Client kick-off — Al Noor Trading",
    0,
    1,
    "10:00",
    "11:00",
    "Client office, West Bay",
    ["u-admin", "u-omar"],
    "u-admin",
    "Agree scope, timeline and the document checklist for registration.",
  ],
  [
    "m-5",
    "Brand review — City Bakers",
    0,
    1,
    "10:30",
    "11:30",
    "https://meet.example.com/brand-review",
    ["u-omar", "u-sara", "u-daniel"],
    "u-omar",
  ],
  [
    "m-6",
    "Mentorship programme planning",
    0,
    2,
    "13:00",
    "14:00",
    "Meeting room 2",
    ["u-sara", "u-daniel"],
    "u-sara",
  ],
  [
    "m-7",
    "Bank account opening prep",
    0,
    3,
    "09:30",
    "10:00",
    "https://meet.example.com/bank-prep",
    ["u-admin", "u-omar"],
    "u-admin",
  ],
  [
    "m-8",
    "Quarterly partner review",
    0,
    4,
    "15:00",
    "16:30",
    "Board room",
    ["u-admin", "u-daniel"],
    "u-admin",
    "Review Q3 results and pipeline. Prepare the partner report.",
  ],
  ["m-9", "Weekly team sync", 1, 0, "09:00", "09:45", "Meeting room 1", EVERYONE, "u-admin"],
  [
    "m-10",
    "Demo day logistics",
    1,
    2,
    "14:00",
    "15:00",
    "Meeting room 1",
    ["u-sara", "u-omar"],
    "u-sara",
  ],
  [
    "m-11",
    "Fintech market entry workshop",
    1,
    3,
    "10:00",
    "12:00",
    "Client office",
    ["u-omar", "u-admin"],
    "u-omar",
  ],
]

/** Seed task number → meeting it came out of (action items). */
const TASK_MEETING: Record<number, string> = {
  1: "m-4",
  3: "m-6",
  4: "m-5",
  8: "m-8",
  18: "m-7",
  20: "m-2",
}

export function buildSeedMeetings(): Meeting[] {
  const now = new Date().toISOString()
  return MEETINGS.map(
    ([id, title, week, day, startTime, endTime, location, attendeeIds, organizerId, notes]) => ({
      id,
      accountId: ACME,
      title,
      notes: notes ?? "",
      date: weekDay(week, day),
      startTime,
      endTime,
      location,
      attendeeIds,
      organizerId,
      createdAt: now,
      updatedAt: now,
    }),
  )
}

export const SEED_ACCOUNTS: Account[] = [
  { id: ACME, name: "Acme Consulting", active: true, createdAt: now, logoUrl: null, timeZone: null },
  { id: NORTHWIND, name: "Northwind Trading", active: true, createdAt: now, logoUrl: null, timeZone: null },
]

export const SEED_MEMBERSHIPS: Membership[] = [
  { id: "mb-1", accountId: ACME, userId: "u-admin", role: "administrator", createdAt: now },
  { id: "mb-2", accountId: ACME, userId: "u-omar", role: "member", createdAt: now },
  { id: "mb-3", accountId: ACME, userId: "u-sara", role: "member", createdAt: now },
  { id: "mb-4", accountId: ACME, userId: "u-daniel", role: "member", createdAt: now },
  // Multi-workspace: Sara runs Northwind; Aisha is a member there.
  { id: "mb-5", accountId: NORTHWIND, userId: "u-sara", role: "administrator", createdAt: now },
  { id: "mb-6", accountId: NORTHWIND, userId: "u-admin", role: "member", createdAt: now },
]

const NORTHWIND_TASKS: [string, TaskStatus, TaskPriority, number | null, string[]][] = [
  ["Confirm shipment schedule with Jebel Ali agent", "in_progress", "high", 1, ["u-sara"]],
  ["Renew import licence", "open", "urgent", 3, ["u-sara", "u-admin"]],
  ["Update supplier price list", "open", "medium", 8, ["u-admin"]],
  ["Warehouse safety inspection", "open", "low", 12, ["u-sara"]],
  ["Close Q3 supplier invoices", "completed", "medium", -5, ["u-admin"]],
]

export function buildNorthwindTasks(): Task[] {
  const at = new Date().toISOString()
  return NORTHWIND_TASKS.map(([title, status, priority, due, assigneeIds], i) => ({
    id: `nw-t-${i + 1}`,
    accountId: NORTHWIND,
    title,
    description: "",
    status,
    priority,
    startDate: "",
    startTime: "",
    dueDate: due === null ? "" : isoDay(due),
    dueTime: "",
    assigneeIds,
    createdById: "u-sara",
    meetingId: i === 1 ? "nw-m-1" : null,
    private: false,
    googleSync: false,
    completedAt: status === "completed" ? at : null,
    createdAt: at,
    updatedAt: at,
  }))
}

export function buildNorthwindMeetings(): Meeting[] {
  const at = new Date().toISOString()
  const rows: [string, string, number, number, string, string, string, string[]][] = [
    [
      "nw-m-1",
      "Northwind ops review",
      0,
      1,
      "11:00",
      "12:00",
      "Warehouse office",
      ["u-sara", "u-admin"],
    ],
    [
      "nw-m-2",
      "Supplier call — Gulf Freight",
      0,
      3,
      "14:00",
      "14:30",
      "https://meet.example.com/gulf-freight",
      ["u-sara"],
    ],
    [
      "nw-m-3",
      "Northwind weekly",
      1,
      0,
      "10:00",
      "10:30",
      "Warehouse office",
      ["u-sara", "u-admin"],
    ],
  ]
  return rows.map(([id, title, week, day, startTime, endTime, location, attendeeIds]) => ({
    id,
    accountId: NORTHWIND,
    title,
    notes: "",
    date: weekDay(week, day),
    startTime,
    endTime,
    location,
    attendeeIds,
    organizerId: "u-sara",
    createdAt: at,
    updatedAt: at,
  }))
}
