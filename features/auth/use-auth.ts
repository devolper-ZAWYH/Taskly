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

/**
 * A `?next=` path to return to after signing in (e.g. Claude's consent
 * screen). Only paths on this site: never `//other.host` or a full URL.
 */
export function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null
  return next
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

/** Sign in, then go to `next` (a safe same-site path) or the usual home. */
export function useLogin(next: string | null = null) {
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
      router.replace(next ?? homePath(user))
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
