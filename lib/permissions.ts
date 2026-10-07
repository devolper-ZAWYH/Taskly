/**
 * Who may see or change what. Shared by the server (enforcement) and the UI
 * (hiding actions a person can't take).
 *
 * Administrators create and manage tasks and meetings. Members only see the
 * tasks assigned to them (never cancelled ones) and the meetings they take
 * part in, and may move their own tasks through the workflow (status only).
 */
import type { Meeting, Role, Task, TaskStatus } from "@/lib/types"

/** Who is looking, inside one workspace (role is the workspace role). */
export type Viewer = { id: string; role: Role }

export const CLOSED_STATUSES: TaskStatus[] = ["completed", "cancelled"]

/** Statuses a member may set on a task assigned to them (cancelling is an admin call). */
export const MEMBER_STATUSES: TaskStatus[] = ["open", "in_progress", "on_hold", "completed"]

export function isClosed(status: TaskStatus): boolean {
  return CLOSED_STATUSES.includes(status)
}

const isAdmin = (viewer: Viewer) => viewer.role === "administrator"

export function canCreateTask(viewer: Viewer): boolean {
  return isAdmin(viewer)
}

export function canViewTask(viewer: Viewer, task: Task): boolean {
  if (isAdmin(viewer)) return true
  return task.status !== "cancelled" && task.assigneeIds.includes(viewer.id)
}

/** Title, description, dates, priority, assignees, related meeting. */
export function canEditTask(viewer: Viewer): boolean {
  return isAdmin(viewer)
}

export function canChangeTaskStatus(viewer: Viewer, task: Task): boolean {
  return canViewTask(viewer, task)
}

export function canDeleteTask(viewer: Viewer): boolean {
  return isAdmin(viewer)
}

export function canCreateMeeting(viewer: Viewer): boolean {
  return isAdmin(viewer)
}

export function canViewMeeting(viewer: Viewer, meeting: Meeting): boolean {
  return (
    isAdmin(viewer) ||
    meeting.organizerId === viewer.id ||
    meeting.attendeeIds.includes(viewer.id)
  )
}

export function canEditMeeting(viewer: Viewer): boolean {
  return isAdmin(viewer)
}
