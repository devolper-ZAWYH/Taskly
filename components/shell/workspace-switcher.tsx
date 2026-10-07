"use client"

import { Building2Icon, CheckIcon, ChevronDownIcon, LayoutGridIcon, ShieldIcon } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import { useNavWorkspace } from "@/components/shell/nav-items"
import { useCurrentUser } from "@/features/auth/use-auth"
import { useMyWorkspaces, workspacePath } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import { cn } from "@/lib/utils"

export function WorkspaceSwitcher({
  isCollapsed = false,
  className,
}: {
  isCollapsed?: boolean
  className?: string
}): React.ReactElement | null {
  const { t } = useLocale()
  const me = useCurrentUser()
  const router = useRouter()
  const pathname = usePathname()
  const { data: workspaces = [] } = useMyWorkspaces()
  const current = useNavWorkspace()
  const accountId = current?.account.id
  const inPlatform = pathname.startsWith("/platform")
  const own = workspaces.filter((w) => !w.viaOperator)
  const others = workspaces.filter((w) => w.viaOperator)

  // A single-workspace member has nothing to switch to.
  if (workspaces.length <= 1 && !me.isOperator) return null

  const label = current
    ? current.account.name
    : inPlatform
      ? t("platform.console")
      : t("workspaces.choose")
  const Icon = inPlatform && !current ? ShieldIcon : Building2Icon

  return (
    <Menu>
      <MenuTrigger
        data-testid="workspace-switcher"
        aria-label={label}
        className={cn(
          "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-start text-(--app-sidebar-text) transition outline-none hover:bg-(--app-sidebar-hover) focus-visible:ring-2 focus-visible:ring-ring",
          isCollapsed ? "size-10 justify-center px-0" : "w-full",
          className,
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {!isCollapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </>
        ) : null}
      </MenuTrigger>
      <MenuPopup
        side={isCollapsed ? "inline-end" : "bottom"}
        align={isCollapsed ? "start" : "center"}
        className="w-64"
      >
        {own.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>{t("workspaces.yours")}</MenuGroupLabel>
            {own.map((w) => (
              <MenuItem
                key={w.account.id}
                onClick={() => router.push(workspacePath(w.account.id, "/tasks"))}
              >
                <CheckIcon className={cn(w.account.id === accountId ? "" : "invisible")} />
                <span className="min-w-0 flex-1 truncate">{w.account.name}</span>
                <span className="text-xs text-foreground-muted">{t(`roles.${w.role}`)}</span>
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        {others.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("workspaces.operatorAccess")}</MenuGroupLabel>
              {others.map((w) => (
                <MenuItem
                  key={w.account.id}
                  onClick={() => router.push(workspacePath(w.account.id, "/tasks"))}
                >
                  <CheckIcon className={cn(w.account.id === accountId ? "" : "invisible")} />
                  <span className="min-w-0 flex-1 truncate">{w.account.name}</span>
                </MenuItem>
              ))}
            </MenuGroup>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => router.push("/workspaces")}>
          <LayoutGridIcon />
          {t("workspaces.all")}
        </MenuItem>
        {me.isOperator ? (
          <MenuItem onClick={() => router.push("/platform")}>
            <ShieldIcon />
            {t("platform.console")}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  )
}
