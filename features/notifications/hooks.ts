"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import {
  getEmailAvailable,
  getNotificationPrefs,
  listNotifications,
  markNotificationsRead,
  setNotificationPref,
  unreadNotificationCount,
} from "@/lib/api/notifications"
import type { NotificationChannel, NotificationKind } from "@/lib/types"

export const NOTIFICATIONS_KEY = ["notifications"] as const

/** The bell list; only fetched while the panel is open. */
export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "list"],
    queryFn: listNotifications,
    enabled,
  })
}

/**
 * Unread count for the badge. Refreshed every few minutes while the tab is
 * visible, on focus, and immediately when a push arrives (see the bridge).
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "unread"],
    queryFn: unreadNotificationCount,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  })
}

export function useMarkRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[] | "all") => markNotificationsRead(ids),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}

export function useNotificationPrefs() {
  return useQuery({ queryKey: [...NOTIFICATIONS_KEY, "prefs"], queryFn: getNotificationPrefs })
}

/** Whether the server can send email; the Email switches stay off without it. */
export function useEmailAvailable() {
  return useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "email-available"],
    queryFn: getEmailAvailable,
    staleTime: Infinity,
  })
}

export function useSetNotificationPref() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (v: { kind: NotificationKind; channel: NotificationChannel; enabled: boolean }) =>
      setNotificationPref(v.kind, v.channel, v.enabled),
    onSuccess: (prefs) => queryClient.setQueryData([...NOTIFICATIONS_KEY, "prefs"], prefs),
  })
}

/** When the service worker shows a push, refresh the badge and list right away. */
export function usePushRefresh(): void {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "notification") {
        void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY })
      }
    }
    navigator.serviceWorker.addEventListener("message", onMessage)
    return () => navigator.serviceWorker.removeEventListener("message", onMessage)
  }, [queryClient])
}
