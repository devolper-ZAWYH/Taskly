import { rpc } from "@/lib/api/rpc"
import type { Page, Task, TaskFilters, TaskInput, TaskScope } from "@/lib/types"

export {
  canChangeTaskStatus,
  canCreateTask,
  canDeleteTask,
  canEditTask,
  canViewMeeting,
  canViewTask,
  isClosed,
  MEMBER_STATUSES,
  type Viewer,
} from "@/lib/permissions"
export type { TaskInput } from "@/lib/types"

export const listTasks = (
  accountId: string,
  params: {
    scope: TaskScope
    search: string
    page: number
    pageSize: number
    filters?: TaskFilters
  },
): Promise<Page<Task>> => rpc("listTasks", accountId, params)

/** Look up by id or display reference (`T-12` / `12`) within the workspace. */
export const getTask = (accountId: string, ref: string): Promise<Task> =>
  rpc("getTask", accountId, ref)

export const createTask = (accountId: string, input: TaskInput): Promise<Task> =>
  rpc("createTask", accountId, input)

export const updateTask = (accountId: string, id: string, patch: Partial<TaskInput>): Promise<Task> =>
  rpc("updateTask", accountId, id, patch)

export const cancelTask = (accountId: string, id: string): Promise<Task> =>
  rpc("cancelTask", accountId, id)

export const deleteTask = (accountId: string, id: string): Promise<void> =>
  rpc("deleteTask", accountId, id)

/** Tasks with a due date in `[from, to]` (YYYY-MM-DD), for the calendar. */
export const listCalendarTasks = (
  accountId: string,
  params: { from: string; to: string },
): Promise<Task[]> => rpc("listCalendarTasks", accountId, params)
