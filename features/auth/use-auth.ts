"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { getMe, login, logout } from "@/lib/api/auth"
import { useLocale } from "@/lib/i18n/locale-provider"
import { disablePush } from "@/lib/push"
import type { PublicUser } from "@/lib/types"

export const ME_KEY = ["me"] as const

/** Where someone lands after signing in. */
export function homePath(user: Pick<PublicUser, "isOperator">): string {
  return user.isOperator ? "/platform" : "/workspaces?auto=1"
}

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: getMe, staleTime: Infinity })
}

/** The signed-in user. Only call inside the authenticated `(app)` layout. */
export function useCurrentUser(): PublicUser {
  const { data } = useMe()
  if (!data) throw new Error("useCurrentUser called without a session")
  return data
}

export function useLogin() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const { setLocale } = useLocale()
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      login(email, password),
    onSuccess: (user) => {
      queryClient.clear()
      queryClient.setQueryData(ME_KEY, user)
      setLocale(user.locale)
      router.replace(homePath(user))
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  const router = useRouter()
  return async () => {
    // A shared device must stop receiving this person's notifications.
    await disablePush().catch(() => {})
    await logout()
    queryClient.clear()
    queryClient.setQueryData(ME_KEY, null)
    router.replace("/login")
  }
}
