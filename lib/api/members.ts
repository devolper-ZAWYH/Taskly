/**
 * Workspace membership, as managed by a workspace Administrator.
 * A user is global; a membership attaches them to one workspace with a role.
 */
import { rpc } from "@/lib/api/rpc"
import type {
  AddMemberInput,
  AddMemberResult,
  Page,
  UpdateMemberInput,
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

/** Add someone by email; a new email gets an account with a temporary password. */
export const addMember = (accountId: string, input: AddMemberInput): Promise<AddMemberResult> =>
  rpc("addMember", accountId, input)

export const updateMember = (
  accountId: string,
  userId: string,
  input: UpdateMemberInput,
): Promise<WorkspaceMember> => rpc("updateMember", accountId, userId, input)

/** Revoke someone's access to this workspace (their account and other workspaces stay). */
export const removeMember = (accountId: string, userId: string): Promise<void> =>
  rpc("removeMember", accountId, userId)
