"use client"

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { taskKeys } from "@/features/tasks/hooks/use-tasks"
import { useWorkspace } from "@/features/workspace/workspace-context"
import {
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetingOptions,
  listMeetings,
  listMeetingTasks,
  retranslateMeeting,
  updateMeeting,
  type MeetingInput,
} from "@/lib/api/meetings"
import { listCalendarTasks } from "@/lib/api/tasks"

export const meetingKeys = {
  all: ["meetings"] as const,
  range: (accountId: string, from: string, to: string) =>
    ["meetings", accountId, "range", from, to] as const,
  detail: (accountId: string, id: string) => ["meetings", accountId, "detail", id] as const,
  tasks: (accountId: string, id: string) => ["meetings", accountId, "tasks", id] as const,
  options: (accountId: string) => ["meetings", accountId, "options"] as const,
}

/** Meetings a task can be related to (task form picker). */
export function useMeetingOptions(enabled: boolean) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: meetingKeys.options(accountId),
    queryFn: () => listMeetingOptions(accountId),
    enabled,
  })
}

export function useMeetings(range: { from: string; to: string }) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: meetingKeys.range(accountId, range.from, range.to),
    queryFn: () => listMeetings(accountId, range),
    placeholderData: keepPreviousData,
  })
}

export function useMeeting(id: string | null) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: meetingKeys.detail(accountId, id ?? ""),
    queryFn: () => getMeeting(accountId, id!),
    enabled: Boolean(id),
    // While a translation is on its way, look again every few seconds.
    refetchInterval: (query) =>
      Object.values(query.state.data?.translations ?? {}).some((t) => t?.status === "pending")
        ? 3000
        : false,
  })
}

export function useRetranslateMeeting() {
  const { accountId } = useWorkspace()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => retranslateMeeting(accountId, id),
    onSuccess: (meeting) =>
      queryClient.setQueryData(meetingKeys.detail(accountId, meeting.id), meeting),
  })
}

export function useMeetingTasks(id: string | null) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: meetingKeys.tasks(accountId, id ?? ""),
    queryFn: () => listMeetingTasks(accountId, id!),
    enabled: Boolean(id),
  })
}

/** Task due dates shown on the calendar; lives under the tasks key so task edits refresh it. */
export function useCalendarTasks(range: { from: string; to: string }, enabled: boolean) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: [...taskKeys.workspace(accountId), "calendar", range.from, range.to],
    queryFn: () => listCalendarTasks(accountId, range),
    enabled,
    placeholderData: keepPreviousData,
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: meetingKeys.all }),
      queryClient.invalidateQueries({ queryKey: taskKeys.all }),
    ])
}

export function useCreateMeeting() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: MeetingInput) => createMeeting(accountId, input),
    onSuccess: invalidate,
  })
}

export function useUpdateMeeting() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MeetingInput }) =>
      updateMeeting(accountId, id, input),
    onSuccess: invalidate,
  })
}

export function useDeleteMeeting() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => deleteMeeting(accountId, id),
    onSuccess: invalidate,
  })
}
