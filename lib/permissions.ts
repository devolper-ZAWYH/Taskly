/**
 * Who may see or change what. Shared by the server (enforcement) and the UI
 * (hiding actions a person can't take).
 *
 * Administrators create and manage workspace tasks and meetings. Members only
 * see the workspace tasks assigned to them (never cancelled ones) and the
 * meetings they take part in, and may move those tasks through the workflow
 * (status only). Anyone may create private tasks for themselves: only their
 * creator sees them, administrators included, and the creator fully manages them.
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

type TaskAccess = Pick<Task, "private" | "createdById" | "status" | "assigneeIds">

/** A private task of the viewer's own. */
export function isOwnPrivateTask(viewer: Viewer, task: Pick<Task, "private" | "createdById">): boolean {
  return task.private && task.createdById === viewer.id
}

/**
 * Workspace (shared) tasks, assigned to other people: administrators only.
 * Anyone may create private tasks for themselves.
 */
export function canCreateSharedTask(viewer: Viewer): boolean {
  return isAdmin(viewer)
}

export function canViewTask(viewer: Viewer, task: TaskAccess): boolean {
  if (task.private) return task.createdById === viewer.id
  if (isAdmin(viewer)) return true
  return task.status !== "cancelled" && task.assigneeIds.includes(viewer.id)
}

/** Title, description, dates, priority, assignees, related meeting. */
export function canEditTask(viewer: Viewer, task: TaskAccess): boolean {
  if (task.private) return task.createdById === viewer.id
  return isAdmin(viewer)
}

export function canChangeTaskStatus(viewer: Viewer, task: TaskAccess): boolean {
  return canViewTask(viewer, task)
}

export function canDeleteTask(viewer: Viewer, task: TaskAccess): boolean {
  return canEditTask(viewer, task)
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
