"use client"

import {
  BellIcon,
  Building2Icon,
  CalendarDaysIcon,
  LogOutIcon,
  SettingsIcon,
  ShieldIcon,
  SquareCheckBigIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"
import { useParams, usePathname } from "next/navigation"
import { useCurrentUser, useLogout } from "@/features/auth/use-auth"
import { useUnreadCount } from "@/features/notifications/hooks"
import { useNotificationsPanel } from "@/features/notifications/notifications-panel"
import { useMyWorkspaces, workspacePath } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import { getLastWorkspaceId } from "@/lib/preferences"
import type { MyWorkspace } from "@/lib/types"
import { cn } from "@/lib/utils"

export type NavItem = {
  name: string
  label: string
  icon: LucideIcon
  href?: string
  onClick?: () => void
  isCurrent?: boolean
  /** Flip the icon in RTL (directional icons). */
  flipRtl?: boolean
  danger?: boolean
  /** Unread count shown on the item (0 hides it). */
  badge?: number
}

export type NavGroup = { label?: string; items: NavItem[] }

/**
 * The workspace the sidebar is about: the one in the URL, else (outside the
 * platform console) the last-used one, else the user's only workspace.
 */
export function useNavWorkspace(): MyWorkspace | undefined {
  const pathname = usePathname()
  const me = useCurrentUser()
  const { accountId } = useParams<{ accountId?: string }>()
  const { data: workspaces = [] } = useMyWorkspaces()
  if (accountId) return workspaces.find((w) => w.account.id === accountId)
  if (pathname.startsWith("/platform")) return undefined
  const lastId = getLastWorkspaceId(me.id)
  return (
    workspaces.find((w) => w.account.id === lastId) ??
    (workspaces.length === 1 ? workspaces[0] : undefined)
  )
}

/**
 * Main navigation. Inside a workspace it links that workspace; on pages outside
 * one (settings, the picker) it keeps linking the last-used workspace so Tasks
 * and Calendar stay reachable; the platform console gets its own links.
 */
export function useNavGroups(): NavGroup[] {
  const { t } = useLocale()
  const pathname = usePathname()
  const me = useCurrentUser()
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>()
  const workspace = useNavWorkspace()
  const inPlatform = pathname.startsWith("/platform")
  const accountId = routeAccountId ?? workspace?.account.id
  const link = (name: string, label: string, icon: LucideIcon, href: string): NavItem => ({
    name,
    label,
    icon,
    href,
    isCurrent: pathname.startsWith(href),
  })

  const platformGroup: NavGroup = {
    label: t("platform.console"),
    items: [
      link("accounts", t("platform.accounts"), Building2Icon, "/platform/accounts"),
      link("platform-users", t("platform.users"), UsersIcon, "/platform/users"),
    ],
  }

  if (accountId) {
    return [
      {
        items: [
          link("tasks", t("nav.tasks"), SquareCheckBigIcon, workspacePath(accountId, "/tasks")),
          link(
            "calendar",
            t("nav.calendar"),
            CalendarDaysIcon,
            workspacePath(accountId, "/calendar"),
          ),
          ...(workspace?.role === "administrator"
            ? [link("members", t("nav.members"), UsersIcon, workspacePath(accountId, "/members"))]
            : []),
        ],
      },
    ]
  }

  return inPlatform || me.isOperator ? [platformGroup] : []
}

/** Items pinned to the bottom of the sidebar, above the profile. */
export function useBottomNavItems(): NavItem[] {
  const { t } = useLocale()
  const pathname = usePathname()
  const me = useCurrentUser()
  const logout = useLogout()
  const panel = useNotificationsPanel()
  const unread = useUnreadCount().data ?? 0

  return [
    ...(me.isOperator
      ? [
          {
            name: "platform",
            label: t("platform.console"),
            icon: ShieldIcon,
            href: "/platform",
            isCurrent: pathname.startsWith("/platform"),
          },
        ]
      : []),
    {
      name: "notifications",
      label: t("notifications.title"),
      icon: BellIcon,
      onClick: () => panel.setOpen(true),
      badge: unread,
    },
    {
      name: "settings",
      label: t("nav.settings"),
      icon: SettingsIcon,
      href: "/settings",
      isCurrent: pathname.startsWith("/settings"),
    },
    {
      name: "sign-out",
      label: t("nav.signOut"),
      icon: LogOutIcon,
      flipRtl: true,
      danger: true,
      onClick: () => void logout(),
    },
  ]
}

const navActive = cn(
  "aria-[current=page]:bg-(--app-sidebar-active)",
  "aria-[current=page]:font-medium",
  "aria-[current=page]:text-(--app-sidebar-text-active)",
  "aria-[current=page]:[&_svg]:text-(--app-sidebar-icon-active)",
)

/** Shared nav item layout for the expanded sidebar vs the collapsed icon rail. */
export function navItemClassName(isIconOnly: boolean): string {
  if (isIconOnly) {
    return cn(
      "mx-auto flex size-[46px] shrink-0 cursor-pointer items-center justify-center rounded-md p-3 text-(--app-sidebar-icon) transition",
      "hover:bg-(--app-sidebar-hover)",
      navActive,
    )
  }

  return cn(
    "flex h-[46px] w-full cursor-pointer items-center gap-4 rounded-md px-2 text-base font-normal text-(--app-sidebar-text) transition",
    "hover:bg-(--app-sidebar-hover)",
    "[&_svg]:text-(--app-sidebar-icon)",
    navActive,
    "md:justify-center lg:justify-start",
  )
}

export const navIconClassName = "size-[22px] shrink-0 stroke-[1.8]"
