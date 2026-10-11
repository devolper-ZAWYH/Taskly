/**
 * Workspace membership, as managed by a workspace Administrator.
 * A user is global; a membership attaches them to one workspace with a role.
 */
import { rpc } from "@/lib/api/rpc"
import type {
  AddMemberInput,
  AddMemberResult,
  MyInvitation,
  Page,
  UpdateMemberInput,
  WorkspaceInvitation,
  WorkspaceMember,
} from "@/lib/types"

export type { AddMemberInput, AddMemberResult, UpdateMemberInput } from "@/lib/types"

/** Everyone in the workspace (assignee picker, avatars). */
export const listPeople = (accountId: string): Promise<WorkspaceMember[]> =>
  rpc("listPeople", accountId)

export const listMembers = (
  accountId: string,
  params: { search: string; page: number; pageSize: number },
): Promise<Page<WorkspaceMember>> => rpc("listMembers", accountId, params)

/**
 * Add someone by email. A new email gets an account and an emailed invitation
 * (or a temporary password when email isn't available); someone who already
 * has an account is invited and joins when they accept.
 */
export const addMember = (accountId: string, input: AddMemberInput): Promise<AddMemberResult> =>
  rpc("addMember", accountId, input)

export const updateMember = (
  accountId: string,
  userId: string,
  input: UpdateMemberInput,
): Promise<WorkspaceMember> => rpc("updateMember", accountId, userId, input)

/** Email a fresh invitation link to a member who hasn't set their password yet. */
export const resendInvite = (accountId: string, userId: string): Promise<void> =>
  rpc("resendInvite", accountId, userId)

/** Revoke someone's access to this workspace (their account and other workspaces stay). */
export const removeMember = (accountId: string, userId: string): Promise<void> =>
  rpc("removeMember", accountId, userId)

/** People with accounts invited to this workspace who haven't answered yet. */
export const listInvitations = (accountId: string): Promise<WorkspaceInvitation[]> =>
  rpc("listInvitations", accountId)

/** Remind them (notification and email again). */
export const resendInvitation = (accountId: string, id: string): Promise<void> =>
  rpc("resendInvitation", accountId, id)

export const cancelInvitation = (accountId: string, id: string): Promise<void> =>
  rpc("cancelInvitation", accountId, id)

/** Invitations waiting for the signed-in person. */
export const listMyInvitations = (): Promise<MyInvitation[]> => rpc("listMyInvitations")

/** Accept (join) or decline; `accountId` is the joined workspace when accepted. */
export const answerInvitation = (
  id: string,
  accept: boolean,
): Promise<{ accountId: string | null }> => rpc("answerInvitation", id, accept)
