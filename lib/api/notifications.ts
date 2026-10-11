import { rpc } from "@/lib/api/rpc"
import type {
  AppNotification,
  NotificationChannel,
  NotificationKind,
  NotificationPrefs,
} from "@/lib/types"

export const listNotifications = (): Promise<{ items: AppNotification[]; unread: number }> =>
  rpc("listNotifications")

export const unreadNotificationCount = (): Promise<number> => rpc("unreadNotificationCount")

/** Mark some notifications (by id) or `"all"` as read. */
export const markNotificationsRead = (ids: string[] | "all"): Promise<void> =>
  rpc("markNotificationsRead", ids)

export const getNotificationPrefs = (): Promise<NotificationPrefs> => rpc("getNotificationPrefs")

export const setNotificationPref = (
  kind: NotificationKind,
  channel: NotificationChannel,
  enabled: boolean,
): Promise<NotificationPrefs> => rpc("setNotificationPref", kind, channel, enabled)

export const getPushPublicKey = (): Promise<string | null> => rpc("getPushPublicKey")

/** Whether the server can send email (otherwise the Email column is off). */
export const getEmailAvailable = (): Promise<boolean> => rpc("getEmailAvailable")

export const savePushSubscription = (subscription: { endpoint: string }): Promise<void> =>
  rpc("savePushSubscription", subscription)

export const removePushSubscription = (endpoint: string): Promise<void> =>
  rpc("removePushSubscription", endpoint)
