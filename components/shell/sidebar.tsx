"use client"

/**
 * App shell sidebar — ported from the Pretace app shell: a sticky rail that
 * collapses to icons (remembered per browser, forced on tablet widths) and is
 * replaced by the mobile top bar + bottom nav below `md`.
 */

import { LanguagesIcon, PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { WorkspaceBrand } from "@/components/shell/brand"
import { useToggleLocale } from "@/components/shell/language-toggle"
import {
  navIconClassName,
  navItemClassName,
  useBottomNavItems,
  useNavGroups,
  useNavWorkspace,
  type NavItem,
} from "@/components/shell/nav-items"
import { NavTooltip } from "@/components/shell/nav-tooltip"
import { useSidebarCollapse } from "@/components/shell/sidebar-collapse"
import { UserAvatar } from "@/components/shell/user-avatar"
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher"
import { homePath, useCurrentUser } from "@/features/auth/use-auth"
import { useMyWorkspaces } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import { cn } from "@/lib/utils"

function SidebarNavItem({ item, isIconOnly }: { item: NavItem; isIconOnly: boolean }) {
  const Icon = item.icon
  const badge = item.badge ? (item.badge > 99 ? "99+" : String(item.badge)) : null
  const content = (
    <>
      <span className="relative shrink-0">
        <Icon className={cn(navIconClassName, item.flipRtl && "rtl-flip")} aria-hidden="true" />
        {badge && isIconOnly ? (
          <span className="absolute -end-1 -top-1 size-2.5 rounded-full bg-brand ring-2 ring-(--app-sidebar-bg)" />
        ) : null}
      </span>
      {!isIconOnly ? <span className="flex w-full truncate">{item.label}</span> : null}
      {badge && !isIconOnly ? (
        <span
          data-testid={`badge-${item.name}`}
          className="ms-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-foreground tabular-nums"
        >
          {badge}
        </span>
      ) : null}
    </>
  )
  const className = cn(navItemClassName(isIconOnly), item.danger && "hover:text-destructive")

  const element = item.href ? (
    <Link
      href={item.href}
      aria-label={item.label}
      aria-current={item.isCurrent ? "page" : undefined}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      aria-label={badge ? `${item.label} (${badge})` : item.label}
      onClick={item.onClick}
      className={className}
    >
      {content}
    </button>
  )

  return (
    <NavTooltip content={item.label} hidden={!isIconOnly}>
      {element}
    </NavTooltip>
  )
}

function SidebarHeader() {
  const { t } = useLocale()
  const me = useCurrentUser()
  const workspace = useNavWorkspace()
  const { isIconOnly, mounted, isCollapsed, toggleCollapsed, expandSidebar } = useSidebarCollapse()

  if (mounted && isIconOnly) {
    return (
      <header className="flex w-full justify-center">
        <NavTooltip content={t("nav.openSidebar")}>
          <button
            type="button"
            onClick={expandSidebar}
            aria-label={t("nav.openSidebar")}
            className="flex size-[46px] cursor-pointer items-center justify-center rounded-md text-(--app-sidebar-text) transition hover:bg-(--app-sidebar-hover)"
          >
            <PanelLeftIcon className="rtl-flip size-[22px] stroke-[1.8]" />
          </button>
        </NavTooltip>
      </header>
    )
  }

  return (
    <header className="relative hidden w-full items-center px-2 pt-3 pb-6 lg:flex">
      <Link href={homePath(me)} className="min-w-0 flex-1 pe-9" aria-label={t("app.name")}>
        <WorkspaceBrand
          logoUrl={workspace?.account.logoUrl}
          name={workspace?.account.name}
          wordmark={t("app.name")}
        />
      </Link>
      <NavTooltip content={t("nav.closeSidebar")}>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={t("nav.closeSidebar")}
          className="absolute end-0 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md bg-(--app-sidebar-bg) text-(--app-sidebar-text) opacity-0 transition group-hover/sidebar:opacity-100 hover:bg-(--app-sidebar-hover) focus-visible:opacity-100"
        >
          {isCollapsed ? (
            <PanelLeftIcon className="rtl-flip size-[18px] stroke-[1.8]" />
          ) : (
            <PanelLeftCloseIcon className="rtl-flip size-[18px] stroke-[1.8]" />
          )}
        </button>
      </NavTooltip>
    </header>
  )
}

function LanguageIconButton({ isIconOnly }: { isIconOnly: boolean }) {
  const { t } = useLocale()
  const toggle = useToggleLocale()
  return (
    <NavTooltip content={t("nav.language")} side={isIconOnly ? "inline-end" : "top"}>
      <button
        type="button"
        aria-label={t("nav.language")}
        onClick={toggle}
        className={
          isIconOnly
            ? navItemClassName(true)
            : "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--app-sidebar-text) transition hover:bg-(--app-sidebar-hover)"
        }
      >
        <LanguagesIcon className={isIconOnly ? navIconClassName : "size-4 stroke-[1.8]"} />
      </button>
    </NavTooltip>
  )
}

function SidebarProfile({ isIconOnly }: { isIconOnly: boolean }) {
  const { t } = useLocale()
  const me = useCurrentUser()
  const { accountId } = useParams<{ accountId?: string }>()
  const { data: workspaces } = useMyWorkspaces()
  const current = workspaces?.find((w) => w.account.id === accountId)
  const role = current
    ? current.viaOperator
      ? t("roles.operator")
      : t(`roles.${current.role}`)
    : me.isOperator
      ? t("roles.operator")
      : me.email

  const avatar = (
    <UserAvatar
      name={me.name}
      src={me.avatarUrl}
      className="size-9 bg-(--app-sidebar-hover) font-semibold text-(--app-sidebar-text) ring-0"
    />
  )

  if (isIconOnly) {
    return (
      <NavTooltip content={`${me.name}\n${me.email}\n${role}`}>
        <Link
          href="/settings"
          aria-label={me.name}
          className="flex size-[46px] items-center justify-center rounded-md transition hover:bg-(--app-sidebar-hover)"
        >
          {avatar}
        </Link>
      </NavTooltip>
    )
  }

  return (
    <div className="flex w-full items-center gap-1 px-1">
      <Link
        href="/settings"
        aria-label={me.name}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-2 transition hover:bg-(--app-sidebar-hover)"
      >
        {avatar}
        <span className="min-w-0 flex-1 text-start">
          <span className="block truncate text-sm font-medium text-(--app-sidebar-text)">
            {me.name}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-(--app-sidebar-text)/55">
            {role}
          </span>
        </span>
      </Link>
      <LanguageIconButton isIconOnly={false} />
    </div>
  )
}

export function Sidebar(): React.ReactElement {
  const { isCollapsed, isIconOnly, mounted } = useSidebarCollapse()
  const groups = useNavGroups()
  const bottomItems = useBottomNavItems()

  return (
    <div className="relative">
      <aside
        data-testid="sidebar"
        className={cn(
          "group/sidebar sticky top-0 hidden h-svh max-h-screen w-[70px] flex-col overflow-hidden rounded-e-[12px] border-e border-(--app-sidebar-border) bg-(--app-sidebar-bg) text-(--app-sidebar-text) transition-[width] duration-200 motion-reduce:transition-none md:flex",
          (!mounted || !isCollapsed) && "lg:w-[245px] lg:px-3",
        )}
      >
        <div className="flex h-full min-h-0 flex-col pt-3 pb-5">
          <SidebarHeader />
          <div className={cn("mb-3 shrink-0", isIconOnly && "flex justify-center")}>
            <WorkspaceSwitcher isCollapsed={isIconOnly} />
          </div>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <nav
              className={cn(
                "flex flex-1 flex-col gap-0.5",
                isIconOnly ? "items-center px-1" : "md:px-1 lg:px-0",
              )}
            >
              {groups.map((group) => (
                <div
                  key={group.label ?? group.items.map((item) => item.name).join("-")}
                  className={cn("flex w-full flex-col gap-0.5", isIconOnly && "items-center")}
                >
                  {group.label ? (
                    <div
                      className={cn(
                        "hidden px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-foreground-muted uppercase",
                        !isIconOnly && "lg:block",
                      )}
                    >
                      {group.label}
                    </div>
                  ) : null}
                  {group.items.map((item) => (
                    <SidebarNavItem key={item.name} item={item} isIconOnly={isIconOnly} />
                  ))}
                </div>
              ))}
            </nav>
          </div>

          <div
            className={cn(
              "mt-auto flex shrink-0 flex-col gap-0.5 border-t border-(--app-sidebar-border) pt-3",
              isIconOnly && "items-center",
            )}
          >
            {bottomItems.map((item) => (
              <SidebarNavItem key={item.name} item={item} isIconOnly={isIconOnly} />
            ))}
            {isIconOnly ? <LanguageIconButton isIconOnly /> : null}
            <SidebarProfile isIconOnly={isIconOnly} />
          </div>
        </div>
      </aside>
    </div>
  )
}
