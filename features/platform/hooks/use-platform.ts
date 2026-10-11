"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useInvalidateMembership } from "@/features/users/hooks/use-users"
import { getGoogleSyncHealth, retryFailedGoogleJobs } from "@/lib/api/google"
import {
  generatePushKeys,
  getPlatformSettings,
  resetPlatformSettings,
  savePlatformSettings,
  sendTestEmail,
} from "@/lib/api/platform-settings"
import {
  attachUser,
  createAccount,
  createUser,
  deleteUser,
  detachUser,
  getAccount,
  listAccountMembers,
  listAccounts,
  listAllUsers,
  resendUserInvite,
  setAccountLogo,
  setMembershipRole,
  setUserPassword,
  updateAccount,
  updateUser,
} from "@/lib/api/platform"
import type { LogoType, PlatformSettings, Role } from "@/lib/types"

export const platformKeys = {
  accounts: (search: string) => ["platform", "accounts", search] as const,
  account: (id: string) => ["platform", "account", id] as const,
  accountMembers: (id: string) => ["platform", "account-members", id] as const,
  users: (search: string) => ["platform", "users", search] as const,
  googleHealth: ["platform", "google-health"] as const,
  settings: ["platform", "settings"] as const,
}

export function useAccounts(search: string) {
  return useQuery({ queryKey: platformKeys.accounts(search), queryFn: () => listAccounts(search) })
}

export function useAccount(id: string | null) {
  return useQuery({
    queryKey: platformKeys.account(id ?? ""),
    queryFn: () => getAccount(id!),
    enabled: Boolean(id),
  })
}

export function useAccountMembers(id: string | null) {
  return useQuery({
    queryKey: platformKeys.accountMembers(id ?? ""),
    queryFn: () => listAccountMembers(id!),
    enabled: Boolean(id),
  })
}

export function usePlatformUsers(search: string) {
  return useQuery({ queryKey: platformKeys.users(search), queryFn: () => listAllUsers(search) })
}

/** Every platform write can change what workspaces/people others see. */
function usePlatformMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const invalidate = useInvalidateMembership()
  return useMutation({ mutationFn: fn, onSuccess: invalidate })
}

export const useCreateAccount = () =>
  usePlatformMutation((input: { name: string }) => createAccount(input))

export const useUpdateAccount = () =>
  usePlatformMutation(
    ({
      id,
      input,
    }: {
      id: string
      input: Partial<{ name: string; active: boolean; timeZone: string | null }>
    }) => updateAccount(id, input),
  )

export const useCreatePlatformUser = () =>
  usePlatformMutation(
    (input: {
      name: string
      email: string
      password: string
      isOperator: boolean
      invite: boolean
    }) => createUser(input),
  )

export const useResendUserInvite = () => useMutation({ mutationFn: resendUserInvite })

export const useUpdatePlatformUser = () =>
  usePlatformMutation(
    ({
      id,
      input,
    }: {
      id: string
      input: Partial<{ name: string; email: string; active: boolean; isOperator: boolean }>
    }) => updateUser(id, input),
  )

export const useSetPlatformUserPassword = () =>
  usePlatformMutation(({ id, password }: { id: string; password: string }) =>
    setUserPassword(id, password),
  )

export const useAttachUser = () =>
  usePlatformMutation(
    ({ accountId, userId, role }: { accountId: string; userId: string; role: Role }) =>
      attachUser(accountId, userId, role),
  )

export const useSetMembershipRole = () =>
  usePlatformMutation(({ membershipId, role }: { membershipId: string; role: Role }) =>
    setMembershipRole(membershipId, role),
  )

export const useDetachUser = () =>
  usePlatformMutation((membershipId: string) => detachUser(membershipId))

export const useDeletePlatformUser = () => usePlatformMutation((id: string) => deleteUser(id))

export const useSetAccountLogo = () =>
  usePlatformMutation(
    ({ id, logo }: { id: string; logo: { contentType: LogoType; data: string } | null }) =>
      setAccountLogo(id, logo),
  )

export function useGoogleSyncHealth() {
  return useQuery({
    queryKey: platformKeys.googleHealth,
    queryFn: getGoogleSyncHealth,
    refetchInterval: 60_000,
  })
}

export function useRetryFailedGoogleJobs() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: retryFailedGoogleJobs,
    onSuccess: (health) => queryClient.setQueryData(platformKeys.googleHealth, health),
  })
}

export function usePlatformSettings() {
  return useQuery({ queryKey: platformKeys.settings, queryFn: getPlatformSettings })
}

/** Saving settings changes what the rest of the app can do (email, Google, push). */
function useSettingsMutation<TArgs>(fn: (args: TArgs) => Promise<PlatformSettings>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (settings) => {
      queryClient.setQueryData(platformKeys.settings, settings)
      void queryClient.invalidateQueries({ queryKey: ["google"] })
      void queryClient.invalidateQueries({ queryKey: ["notifications"] })
    },
  })
}

export const useSavePlatformSettings = () => useSettingsMutation(savePlatformSettings)

export const useResetPlatformSettings = () => useSettingsMutation(resetPlatformSettings)

export const useGeneratePushKeys = () => useSettingsMutation(() => generatePushKeys())

export function useSendTestEmail() {
  return useMutation({ mutationFn: sendTestEmail })
}
