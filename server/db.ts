/**
 * D1 access and row mapping. Tables use snake_case; the app uses the camelCase
 * shapes from `lib/types`.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { Account, Meeting, PublicUser, Role, Task, User } from "@/lib/types"

export function getDb(): D1Database {
  return getCloudflareContext().env.DB
}

export function nowIso(): string {
  return new Date().toISOString()
}

export async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>()
  return results
}

export async function first<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...binds)
    .first<T>()
}

export async function run(db: D1Database, sql: string, ...binds: unknown[]): Promise<void> {
  await db
    .prepare(sql)
    .bind(...binds)
    .run()
}

export type UserRow = {
  id: string
  name: string
  email: string
  password_hash: string
  is_operator: number
  active: number
  locale: string
  created_at: string
  avatar_updated_at: string | null
  timezone: string | null
  calendar_view: string
  /** Set until someone invited by email chooses a password. */
  invited_at: string | null
}

export type AccountRow = {
  id: string
  name: string
  active: number
  created_at: string
  logo_updated_at: string | null
  timezone: string | null
}

export type TaskRow = {
  id: string
  account_id: string
  number: number
  title: string
  description: string
  status: Task["status"]
  priority: Task["priority"]
  start_date: string
  start_time: string
  due_date: string
  due_time: string
  created_by_id: string | null
  meeting_id: string | null
  private: number
  google_sync: number
  completed_at: string | null
  created_at: string
  updated_at: string
  /** JSON array, from `TASK_COLUMNS`. */
  assignee_ids: string
}

export type MeetingRow = {
  id: string
  account_id: string
  title: string
  notes: string
  date: string
  start_time: string
  end_time: string
  location: string
  organizer_id: string
  created_at: string
  updated_at: string
  /** JSON array, from `MEETING_COLUMNS`. */
  attendee_ids: string
}

export type MemberRow = Omit<UserRow, "password_hash"> & { role: Role; membership_id: string }

/** Select list for `tasks t`, including its assignees. */
export const TASK_COLUMNS = `t.*, (SELECT json_group_array(user_id) FROM task_assignees WHERE task_id = t.id) AS assignee_ids`

/** Select list for `meetings m`, including its attendees. */
export const MEETING_COLUMNS = `m.*, (SELECT json_group_array(user_id) FROM meeting_attendees WHERE meeting_id = m.id) AS attendee_ids`

/** Select list for a member: `users u JOIN memberships ms`. */
/** A member's email is the address their workspace knows them by (else their primary). */
export const MEMBER_COLUMNS = `u.id, u.name, COALESCE(ms.email, u.email) AS email, u.is_operator, u.active, u.locale, u.created_at, u.avatar_updated_at, u.timezone, u.calendar_view, u.invited_at, ms.role, ms.id AS membership_id`

export function toUser(row: UserRow): User & { passwordHash: string } {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    isOperator: row.is_operator === 1,
    active: row.active === 1,
    locale: row.locale === "ar" ? "ar" : "en",
    createdAt: row.created_at,
    avatarUrl: avatarUrl(row.id, row.avatar_updated_at),
    timeZone: row.timezone,
    calendarView: row.calendar_view === "list" ? "list" : "calendar",
    invitePending: row.invited_at !== null,
  }
}

export function toPublicUser(row: Omit<UserRow, "password_hash">): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    isOperator: row.is_operator === 1,
    active: row.active === 1,
    locale: row.locale === "ar" ? "ar" : "en",
    createdAt: row.created_at,
    avatarUrl: avatarUrl(row.id, row.avatar_updated_at),
    timeZone: row.timezone,
    calendarView: row.calendar_view === "list" ? "list" : "calendar",
    invitePending: row.invited_at !== null,
  }
}

export function avatarUrl(userId: string, version: string | null): string | null {
  return version ? `/api/avatar/${userId}?v=${encodeURIComponent(version)}` : null
}

export function logoUrl(accountId: string, version: string | null): string | null {
  return version ? `/api/logo/${accountId}?v=${encodeURIComponent(version)}` : null
}

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    active: row.active === 1,
    createdAt: row.created_at,
    logoUrl: logoUrl(row.id, row.logo_updated_at),
    timeZone: row.timezone,
  }
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    startDate: row.start_date,
    startTime: row.start_time,
    dueDate: row.due_date,
    dueTime: row.due_time,
    assigneeIds: JSON.parse(row.assignee_ids) as string[],
    createdById: row.created_by_id,
    meetingId: row.meeting_id,
    private: row.private === 1,
    googleSync: row.google_sync === 1,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    notes: row.notes,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    attendeeIds: JSON.parse(row.attendee_ids) as string[],
    organizerId: row.organizer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toMember(row: MemberRow) {
  return { ...toPublicUser(row), role: row.role, membershipId: row.membership_id }
}
