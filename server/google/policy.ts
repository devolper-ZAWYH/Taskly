/**
 * Who may do what to a workspace item from Google (docs/plan-google-sync.md
 * §5.3): the same rules as the app. `role` is the person's role in that
 * workspace, or null when they can't act there (left it, deactivated, or the
 * workspace is inactive). Pure, so `node --test` can run it directly.
 */
import type { Role } from "@/lib/types"
import type { MeetingFields, TaskFields } from "@/server/google/mapping"

const ADMIN_TASK_FIELDS = [
  "title",
  "description",
  "dueDate",
  "done",
] as const satisfies (keyof TaskFields)[]
/** Members may only change a task's status, as in the app. */
const MEMBER_TASK_FIELDS = ["done"] as const satisfies (keyof TaskFields)[]

const ADMIN_MEETING_FIELDS = [
  "title",
  "notes",
  "date",
  "startTime",
  "endTime",
  "location",
] as const satisfies (keyof MeetingFields)[]

/**
 * Task fields a change in Google may set; any other change is reverted.
 * `ownPrivate`: the person's own private task, which they fully manage.
 */
export function taskFieldsFor(role: Role | null, ownPrivate = false): readonly (keyof TaskFields)[] {
  if (role === null) return []
  if (role === "administrator" || ownPrivate) return ADMIN_TASK_FIELDS
  return MEMBER_TASK_FIELDS
}

/** Whether a task gets Google copies at all: private ones only when their owner asked. */
export function taskSyncs(task: { private: boolean; googleSync: boolean; status: string }): boolean {
  return task.status !== "cancelled" && (!task.private || task.googleSync)
}

/** Meeting fields a change in Google may set; members can't edit meetings. */
export function meetingFieldsFor(role: Role | null): readonly (keyof MeetingFields)[] {
  return role === "administrator" ? ADMIN_MEETING_FIELDS : []
}

/**
 * Someone deleted their copy in Google. An administrator deleting a task they
 * created or a meeting they organise, or anyone deleting their own private
 * task, deletes it in Taskly; any other delete gets the copy back.
 */
export function onCopyDeleted(
  role: Role | null,
  owner: boolean,
  ownPrivate = false,
): "delete" | "restore" {
  if (role === null) return "restore"
  return ownPrivate || (role === "administrator" && owner) ? "delete" : "restore"
}

/**
 * A task someone added to a "Taskly · <Workspace>" list: it becomes their
 * own private task (anyone may create those). Someone who can't act in the
 * workspace gets it moved to their own list.
 */
export function onNewTaskInGoogle(role: Role | null): "import" | "move" {
  return role === null ? "move" : "import"
}

/**
 * An event someone added to a "Taskly · <Workspace>" calendar. An
 * administrator's timed, single-day, non-repeating event becomes a meeting
 * they organise; anything else moves to their primary calendar.
 */
export function onNewEventInGoogle(role: Role | null, meetingShaped: boolean): "import" | "move" {
  return role === "administrator" && meetingShaped ? "import" : "move"
}
