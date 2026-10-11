"use client"

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PEOPLE_KEY } from "@/features/tasks/hooks/use-tasks"
import { MY_WORKSPACES_KEY, useWorkspace } from "@/features/workspace/workspace-context"
import {
  addMember,
  answerInvitation,
  cancelInvitation,
  listInvitations,
  listMembers,
  listMyInvitations,
  removeMember,
  resendInvitation,
  resendInvite,
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
      [["members"], ["invitations"], PEOPLE_KEY, ["me"], MY_WORKSPACES_KEY, ["platform"]].map((queryKey) =>
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

export function useResendInvite() {
  const { accountId } = useWorkspace()
  return useMutation({ mutationFn: (userId: string) => resendInvite(accountId, userId) })
}

/** This workspace's pending invitations (administrators). */
export function useInvitations() {
  const { accountId } = useWorkspace()
  return useQuery({
    queryKey: ["invitations", accountId],
    queryFn: () => listInvitations(accountId),
  })
}

export function useResendInvitation() {
  const { accountId } = useWorkspace()
  return useMutation({ mutationFn: (id: string) => resendInvitation(accountId, id) })
}

export function useCancelInvitation() {
  const { accountId } = useWorkspace()
  const invalidate = useInvalidateMembership()
  return useMutation({
    mutationFn: (id: string) => cancelInvitation(accountId, id),
    onSuccess: invalidate,
  })
}

/** Invitations waiting for me (the workspaces page). Usable outside a workspace. */
export function useMyInvitations() {
  return useQuery({ queryKey: ["invitations", "mine"], queryFn: listMyInvitations })
}

export function useAnswerInvitation() {
  const invalidate = useInvalidateMembership()
  return useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => answerInvitation(id, accept),
    onSuccess: invalidate,
  })
}
