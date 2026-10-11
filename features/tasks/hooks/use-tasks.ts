"use client"

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useWorkspace } from "@/features/workspace/workspace-context"
import { listPeople } from "@/lib/api/members"
import {
  cancelTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
  type TaskInput,
} from "@/lib/api/tasks"
import type { TaskFilters, TaskScope } from "@/lib/types"

/** All task data for one workspace lives under ["tasks", accountId, …]. */
export const taskKeys = {
  all: ["tasks"] as const,
  workspace: (accountId: string) => ["tasks", accountId] as const,
  list: (accountId: string, scope: TaskScope, search: string, page: number, filters: TaskFilters) =>
    ["tasks", accountId, "list", scope, search, page, filters] as const,
  detail: (accountId: string, id: string) => ["tasks", accountId, "detail", id] as const,
}

export const PEOPLE_KEY = ["people"] as const

export const TASKS_PAGE_SIZE = 10

export function useTasks(scope: TaskScope, search: string, page: number, filters: TaskFilters = {}) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: taskKeys.list(accountId, scope, search, page, filters),
    queryFn: () =>
      listTasks(accountId, { scope, search, page, pageSize: TASKS_PAGE_SIZE, filters }),
    placeholderData: keepPreviousData,
  })
}

export function useTask(id: string | null) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: taskKeys.detail(accountId, id ?? ""),
    queryFn: () => getTask(accountId, id!),
    enabled: Boolean(id),
  })
}

/** Members of the current workspace (assignees, attendees, avatars). */
export function usePeople() {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: [...PEOPLE_KEY, accountId],
    queryFn: () => listPeople(accountId),
  })
}

function useInvalidateTasks() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: taskKeys.all }),
      // A meeting's action-item list is a view over tasks.
      queryClient.invalidateQueries({ queryKey: ["meetings"] }),
    ])
}

export function useCreateTask() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateTasks()
  return useMutation({
    mutationFn: (input: TaskInput) => createTask(accountId, input),
    onSuccess: invalidate,
  })
}

export function useUpdateTask() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateTasks()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<TaskInput> }) =>
      updateTask(accountId, id, patch),
    onSuccess: invalidate,
  })
}

export function useCancelTask() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateTasks()
  return useMutation({
    mutationFn: (id: string) => cancelTask(accountId, id),
    onSuccess: invalidate,
  })
}

export function useDeleteTask() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateTasks()
  return useMutation({
    mutationFn: (id: string) => deleteTask(accountId, id),
    onSuccess: invalidate,
  })
}
