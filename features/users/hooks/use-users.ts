"use client"

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PEOPLE_KEY } from "@/features/tasks/hooks/use-tasks"
import { MY_WORKSPACES_KEY, useWorkspace } from "@/features/workspace/workspace-context"
import {
  addMember,
  listMembers,
  removeMember,
  updateMember,
  type AddMemberInput,
  type UpdateMemberInput,
} from "@/lib/api/members"

export const USERS_PAGE_SIZE = 10

export function useUsers(search: string, page: number) {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: ["members", accountId, search, page],
    queryFn: () => listMembers(accountId, { search, page, pageSize: USERS_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
}

/** Membership changes ripple into people lists, the session and the operator console. */
export function useInvalidateMembership() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all(
      [["members"], PEOPLE_KEY, ["me"], MY_WORKSPACES_KEY, ["platform"]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
}

export function useAddMember() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateMembership()
  return useMutation({
    mutationFn: (input: AddMemberInput) => addMember(accountId, input),
    onSuccess: invalidate,
  })
}

export function useUpdateMember() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateMembership()
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UpdateMemberInput }) =>
      updateMember(accountId, userId, input),
    onSuccess: invalidate,
  })
}

export function useRemoveMember() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateMembership()
  return useMutation({
    mutationFn: (userId: string) => removeMember(accountId, userId),
    onSuccess: invalidate,
  })
}
