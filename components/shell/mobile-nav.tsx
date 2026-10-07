"use client"

import { BellIcon, EllipsisIcon, LanguagesIcon, SettingsIcon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { WorkspaceBrand } from "@/components/shell/brand"
import { useToggleLocale } from "@/components/shell/language-toggle"
import { useBottomNavItems, useNavGroups, useNavWorkspace } from "@/components/shell/nav-items"
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher"
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { homePath, useCurrentUser } from "@/features/auth/use-auth"
import { useUnreadCount } from "@/features/notifications/hooks"
import { useNotificationsPanel } from "@/features/notifications/notifications-panel"
import { useLocale } from "@/lib/i18n/locale-provider"
import { cn } from "@/lib/utils"

/** Top bar shown below `md`, where the sidebar is hidden. */
export function MobileTopNav(): React.ReactElement {
  const { t } = useLocale()
  const me = useCurrentUser()
  const workspace = useNavWorkspace()
  const panel = useNotificationsPanel()
  const unread = useUnreadCount().data ?? 0

  return (
    <nav className="sticky top-0 z-40 flex w-full items-center justify-between border-b bg-surface-muted/50 px-4 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] backdrop-blur-lg sm:p-4 sm:pt-[max(1rem,env(safe-area-inset-top))] md:hidden">
      <Link href={homePath(me)} aria-label={t("app.name")} className="max-w-32 shrink-0">
        <WorkspaceBrand
          logoUrl={workspace?.account.logoUrl}
          name={workspace?.account.name}
          wordmark={t("app.name")}
          className="h-7"
        />
      </Link>
      <div className="min-w-0 flex-1 px-2">
        <WorkspaceSwitcher className="mx-auto max-w-48" />
      </div>
      <button
        type="button"
        onClick={() => panel.setOpen(true)}
        aria-label={unread ? `${t("notifications.title")} (${unread})` : t("notifications.title")}
        className="relative me-1 cursor-pointer rounded-full p-1 transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <BellIcon className="size-4 text-foreground" />
        {unread ? (
          <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-brand ring-2 ring-background" />
        ) : null}
      </button>
      <Link
        href="/settings"
        className="rounded-full p-1 text-foreground-muted transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={t("nav.settings")}
      >
        <SettingsIcon className="size-4 text-foreground" />
      </Link>
    </nav>
  )
}

const mobileItemClassName =
  "relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md px-1 py-1.5 text-center text-[10px] leading-tight font-medium text-foreground-muted hover:text-foreground focus:z-10 aria-[current=page]:text-foreground-strong"

/** Bottom tab bar shown below `md`; secondary actions live under "More". */
export function MobileBottomNav(): React.ReactElement {
  const { t } = useLocale()
  const router = useRouter()
  const toggleLocale = useToggleLocale()
  const items = useNavGroups().flatMap((group) => group.items)
  const more = useBottomNavItems().filter(
    (item) => item.name !== "settings" && item.name !== "notifications",
  )

  return (
    <>
      <nav className="fixed bottom-0 left-0 z-30 flex w-full items-stretch justify-around gap-0.5 border-t bg-surface-muted/40 px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] shadow backdrop-blur-md md:hidden">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.name}
              href={item.href ?? "#"}
              aria-current={item.isCurrent ? "page" : undefined}
              aria-label={item.label}
              className={mobileItemClassName}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className="w-full truncate">{item.label}</span>
            </Link>
          )
        })}
        <Menu>
          <MenuTrigger className={mobileItemClassName} aria-label={t("nav.more")}>
            <EllipsisIcon className="size-5 shrink-0" aria-hidden="true" />
            <span className="w-full truncate">{t("nav.more")}</span>
          </MenuTrigger>
          <MenuPopup side="top" align="end" className="w-56">
            <MenuItem onClick={toggleLocale}>
              <LanguagesIcon />
              {t("nav.language")}
            </MenuItem>
            <MenuSeparator />
            {more.map((item) => {
              const Icon = item.icon
              return (
                <MenuItem
                  key={item.name}
                  onClick={() => (item.href ? router.push(item.href) : item.onClick?.())}
                >
                  <Icon className={cn(item.flipRtl && "rtl-flip")} />
                  {item.label}
                </MenuItem>
              )
            })}
          </MenuPopup>
        </Menu>
      </nav>
      <div className="block pt-[calc(3.5rem+env(safe-area-inset-bottom))] md:hidden" />
    </>
  )
}
