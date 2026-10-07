import { rpc } from "@/lib/api/rpc"
import type { AvatarType, CalendarPreference, Locale, MyWorkspace, PublicUser } from "@/lib/types"

export const login = (email: string, password: string): Promise<PublicUser> =>
  rpc("login", email, password)

export const logout = (): Promise<void> => rpc("logout")

/** The current session's user, or null when signed out / deactivated. */
export const getMe = (): Promise<PublicUser | null> => rpc("getMe")

export const updateMe = (input: {
  name?: string
  locale?: Locale
  /** IANA zone, e.g. "Asia/Qatar" (used for due date reminders). */
  timeZone?: string
  /** How the calendar opens on a phone. */
  calendarView?: CalendarPreference
}): Promise<PublicUser> =>
  rpc("updateMe", input)

export const changePassword = (currentPassword: string, newPassword: string): Promise<void> =>
  rpc("changePassword", currentPassword, newPassword)

export const listMyWorkspaces = (): Promise<MyWorkspace[]> => rpc("listMyWorkspaces")

/** Set (base64 square image) or remove (null) your profile picture. */
export const setMyAvatar = (photo: { contentType: AvatarType; data: string } | null): Promise<PublicUser> =>
  rpc("setMyAvatar", photo)
