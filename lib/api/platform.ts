/**
 * Platform operator console: accounts (workspaces), users, and the
 * memberships that attach users to accounts. Operator-only.
 */
import { rpc } from "@/lib/api/rpc"
import type {
  Account,
  AccountSummary,
  LogoType,
  PublicUser,
  Role,
  UserSummary,
  WorkspaceMember,
} from "@/lib/types"

export type { AccountSummary, UserSummary } from "@/lib/types"

export const listAccounts = (search = ""): Promise<AccountSummary[]> => rpc("listAccounts", search)

export const getAccount = (id: string): Promise<AccountSummary> => rpc("getAccount", id)

export const createAccount = (input: { name: string }): Promise<Account> =>
  rpc("createAccount", input)

export const updateAccount = (
  id: string,
  input: Partial<{ name: string; active: boolean; timeZone: string | null }>,
): Promise<Account> => rpc("updateAccount", id, input)

/** Upload (base64) or remove (null) a workspace logo. */
export const setAccountLogo = (
  id: string,
  logo: { contentType: LogoType; data: string } | null,
): Promise<Account> => rpc("setAccountLogo", id, logo)

export const listAccountMembers = (accountId: string): Promise<WorkspaceMember[]> =>
  rpc("listAccountMembers", accountId)

export const listAllUsers = (search = ""): Promise<UserSummary[]> => rpc("listAllUsers", search)

/**
 * With `invite`, they get an email to choose their password; otherwise
 * `password` is theirs. `invited` is false if that email couldn't be sent.
 */
export const createUser = (input: {
  name: string
  email: string
  password: string
  isOperator: boolean
  invite: boolean
}): Promise<PublicUser & { invited: boolean }> => rpc("createUser", input)

/** Email a new password link to someone who hasn't accepted their invitation. */
export const resendUserInvite = (id: string): Promise<void> => rpc("resendUserInvite", id)

export const updateUser = (
  id: string,
  input: Partial<{ name: string; email: string; active: boolean; isOperator: boolean }>,
): Promise<PublicUser> => rpc("updateUser", id, input)

export const setUserPassword = (id: string, password: string): Promise<void> =>
  rpc("setUserPassword", id, password)

/** Removes the person from the platform; their tasks and meetings stay. */
export const deleteUser = (id: string): Promise<void> => rpc("deleteUser", id)

/** Attach a user to an account (workspace) with a role. */
export const attachUser = (accountId: string, userId: string, role: Role): Promise<void> =>
  rpc("attachUser", accountId, userId, role)

export const setMembershipRole = (membershipId: string, role: Role): Promise<void> =>
  rpc("setMembershipRole", membershipId, role)

export const detachUser = (membershipId: string): Promise<void> => rpc("detachUser", membershipId)
