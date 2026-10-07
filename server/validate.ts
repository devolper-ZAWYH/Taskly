/**
 * Runtime checks for values arriving from the browser. TypeScript types end
 * at the network boundary, so every service re-checks the shape it relies on.
 */
import { AppError, MIN_PASSWORD_LENGTH } from "@/lib/api/core"
import type {
  AddMemberInput,
  DueFilter,
  TaskFilters,
  Locale,
  MeetingInput,
  Role,
  TaskInput,
  TaskPriority,
  TaskScope,
  TaskStatus,
  UpdateMemberInput,
} from "@/lib/types"

const bad = (): never => {
  throw new AppError("badRequest")
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function str(value: unknown, max = 200): string {
  if (typeof value !== "string" || value.length > max) bad()
  return value as string
}

export function optStr(value: unknown, max = 200): string | undefined {
  return value === undefined ? undefined : str(value, max)
}

export function bool(value: unknown): boolean {
  if (typeof value !== "boolean") bad()
  return value as boolean
}

export function int(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) bad()
  return value as number
}

export function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) bad()
  return value as T
}

export function ids(value: unknown, max = 200): string[] {
  if (!Array.isArray(value) || value.length > max) bad()
  const list = (value as unknown[]).map((v) => str(v, 100))
  return [...new Set(list)]
}

/** `YYYY-MM-DD`, or "" when `optional`. */
export function date(value: unknown, optional = true): string {
  const v = str(value, 10)
  if (v === "" && optional) return v
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bad()
  return v
}

/** `HH:MM`, or "" when `optional`. */
export function time(value: unknown, optional = true): string {
  const v = str(value, 5)
  if (v === "" && optional) return v
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) bad()
  return v
}

export const ROLES = ["administrator", "member"] as const satisfies readonly Role[]
export const LOCALES = ["en", "ar"] as const satisfies readonly Locale[]
export const STATUSES = [
  "open",
  "in_progress",
  "on_hold",
  "completed",
  "cancelled",
] as const satisfies readonly TaskStatus[]
export const PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const satisfies readonly TaskPriority[]
export const SCOPES = ["assigned", "completed", "all"] as const satisfies readonly TaskScope[]

export const DUE_FILTERS = [
  "overdue",
  "today",
  "week",
  "none",
] as const satisfies readonly DueFilter[]

export function taskFilters(value: unknown): TaskFilters {
  if (value === undefined) return {}
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  const filters: TaskFilters = {
    status: v.status === undefined ? undefined : oneOf(v.status, STATUSES),
    priority: v.priority === undefined ? undefined : oneOf(v.priority, PRIORITIES),
    assigneeId: v.assigneeId === undefined ? undefined : str(v.assigneeId, 100),
    due: v.due === undefined ? undefined : oneOf(v.due, DUE_FILTERS),
    today: v.today === undefined ? undefined : date(v.today, false),
  }
  if (filters.due && filters.due !== "none" && !filters.today) bad()
  return filters
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function assertEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("emailInvalid")
}

export function password(value: unknown): string {
  const v = str(value, 200)
  if (v.length < MIN_PASSWORD_LENGTH) throw new AppError("passwordTooShort")
  return v
}

export function taskInput(value: unknown): TaskInput {
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  return {
    title: str(v.title, 300),
    description: str(v.description, 20_000),
    status: oneOf(v.status, STATUSES),
    priority: oneOf(v.priority, PRIORITIES),
    startDate: date(v.startDate),
    startTime: time(v.startTime),
    dueDate: date(v.dueDate),
    dueTime: time(v.dueTime),
    assigneeIds: ids(v.assigneeIds),
    meetingId: v.meetingId == null ? null : str(v.meetingId, 100),
  }
}

export function taskPatch(value: unknown): Partial<TaskInput> {
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  const patch: Partial<TaskInput> = {}
  if (v.title !== undefined) patch.title = str(v.title, 300)
  if (v.description !== undefined) patch.description = str(v.description, 20_000)
  if (v.status !== undefined) patch.status = oneOf(v.status, STATUSES)
  if (v.priority !== undefined) patch.priority = oneOf(v.priority, PRIORITIES)
  if (v.startDate !== undefined) patch.startDate = date(v.startDate)
  if (v.startTime !== undefined) patch.startTime = time(v.startTime)
  if (v.dueDate !== undefined) patch.dueDate = date(v.dueDate)
  if (v.dueTime !== undefined) patch.dueTime = time(v.dueTime)
  if (v.assigneeIds !== undefined) patch.assigneeIds = ids(v.assigneeIds)
  if (v.meetingId !== undefined)
    patch.meetingId = v.meetingId === null ? null : str(v.meetingId, 100)
  return patch
}

export function meetingInput(value: unknown): MeetingInput {
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  return {
    title: str(v.title, 300),
    notes: str(v.notes, 20_000),
    date: str(v.date, 10),
    startTime: str(v.startTime, 5),
    endTime: str(v.endTime, 5),
    location: str(v.location, 500),
    attendeeIds: ids(v.attendeeIds),
  }
}

export function addMemberInput(value: unknown): AddMemberInput {
  if (!isObject(value)) bad()
  const v = value as Record<string, unknown>
  return { email: str(v.email, 254), role: oneOf(v.role, ROLES) }
}

export function updateMemberInput(value: unknown): UpdateMemberInput {
  if (!isObject(value)) bad()
  return { role: oneOf((value as Record<string, unknown>).role, ROLES) }
}
