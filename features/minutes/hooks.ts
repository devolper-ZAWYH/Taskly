"use client"

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useWorkspace } from "@/features/workspace/workspace-context"
import {
  createMinutes,
  deleteMinutes,
  getMinutes,
  getTranslationAvailable,
  listMeetingMinutes,
  listMinutes,
  translateMinutes,
  updateMinutes,
  type MinutesInput,
} from "@/lib/api/minutes"
import type { MinutesScope } from "@/lib/types"

/** All minutes data lives under ["minutes", accountId, …]. */
export const minutesKeys = {
  all: ["minutes"] as const,
  meeting: (accountId: string, meetingId: string) =>
    ["minutes", accountId, "meeting", meetingId] as const,
  list: (accountId: string, scope: MinutesScope, search: string, page: number) =>
    ["minutes", accountId, "list", scope, search, page] as const,
  detail: (accountId: string, id: string) => ["minutes", accountId, "detail", id] as const,
}

export const MINUTES_PAGE_SIZE = 20

export function useMeetingMinutes(meetingId: string | null) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: minutesKeys.meeting(accountId, meetingId ?? ""),
    queryFn: () => listMeetingMinutes(accountId, meetingId!),
    enabled: Boolean(meetingId),
  })
}

export function useMinutesList(scope: MinutesScope, search: string, page: number) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: minutesKeys.list(accountId, scope, search, page),
    queryFn: () =>
      listMinutes(accountId, { scope, search, page, pageSize: MINUTES_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
}

export function useMinutes(id: string | null) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: minutesKeys.detail(accountId, id ?? ""),
    queryFn: () => getMinutes(accountId, id!),
    enabled: Boolean(id),
  })
}

/** Whether to offer "Translate" (a translation service is set up). */
export function useTranslationAvailable() {
  return useQuery({
    queryKey: ["translation-available"],
    queryFn: getTranslationAvailable,
    staleTime: 5 * 60_000,
  })
}

/** The minutes in the other language, fetched once asked for (`enabled`) per saved version. */
export function useMinutesTranslation(minutes: { id: string; updatedAt: string }, enabled: boolean) {
  const { accountId } = useWorkspace()
  return useQuery({
    // Outside the "minutes" key: saving other minutes mustn't translate this again.
    queryKey: ["minutes-translation", accountId, minutes.id, minutes.updatedAt],
    queryFn: () => translateMinutes(accountId, minutes.id),
    enabled,
    staleTime: Infinity,
    retry: false,
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: minutesKeys.all })
}

/** Create (with a meeting id) or update (with the minutes' id and the version being edited). */
export function useSaveMinutes() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (
      args:
        | { mode: "create"; meetingId: string; input: MinutesInput }
        | { mode: "edit"; id: string; input: MinutesInput; expectedUpdatedAt: string },
    ) =>
      args.mode === "create"
        ? createMinutes(accountId, args.meetingId, args.input)
        : updateMinutes(accountId, args.id, args.input, args.expectedUpdatedAt),
    onSuccess: invalidate,
  })
}

export function useDeleteMinutes() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => deleteMinutes(accountId, id),
    onSuccess: invalidate,
  })
}
