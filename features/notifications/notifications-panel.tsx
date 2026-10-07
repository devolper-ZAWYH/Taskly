"use client"

import { BellIcon, CheckCheckIcon, Loader2Icon } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet"
import { ME_KEY, useCurrentUser } from "@/features/auth/use-auth"
import { useMarkRead, useNotifications, usePushRefresh } from "@/features/notifications/hooks"
import { updateMe } from "@/lib/api/auth"
import { useLocale } from "@/lib/i18n/locale-provider"
import { rebindPush } from "@/lib/push"
import type { AppNotification } from "@/lib/types"
import { cn } from "@/lib/utils"

type PanelContextValue = { open: boolean; setOpen: (open: boolean) => void }
const PanelContext = React.createContext<PanelContextValue | null>(null)

/** Lets the sidebar and the phone top bar open the same panel. */
export function useNotificationsPanel(): PanelContextValue {
  const value = React.useContext(PanelContext)
  if (!value) throw new Error("useNotificationsPanel must be used within NotificationsProvider")
  return value
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const value = React.useMemo(() => ({ open, setOpen }), [open])
  usePushRefresh()
  // This device may have subscribed under someone else on an earlier visit.
  React.useEffect(() => {
    void rebindPush()
  }, [])
  useReportTimeZone()
  return (
    <PanelContext.Provider value={value}>
      {children}
      <NotificationsPanel open={open} onOpenChange={setOpen} />
    </PanelContext.Provider>
  )
}

/** Save this browser's time zone so due date reminders arrive at local 08:00. */
function useReportTimeZone(): void {
  const me = useCurrentUser()
  const queryClient = useQueryClient()
  React.useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!zone || zone === me.timeZone) return
    updateMe({ timeZone: zone })
      .then((user) => queryClient.setQueryData(ME_KEY, user))
      .catch(() => {})
  }, [me.timeZone, queryClient])
}

function useRelativeTime(): (iso: string) => string {
  const { intl } = useLocale()
  return React.useCallback(
    (iso: string) => {
      const rtf = new Intl.RelativeTimeFormat(intl, { numeric: "auto" })
      const seconds = (new Date(iso).getTime() - Date.now()) / 1000
      const steps: [Intl.RelativeTimeFormatUnit, number][] = [
        ["day", 86_400],
        ["hour", 3_600],
        ["minute", 60],
      ]
      for (const [unit, size] of steps) {
        if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
      }
      return rtf.format(0, "minute")
    },
    [intl],
  )
}

function NotificationsPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  const { t } = useLocale()
  const router = useRouter()
  const list = useNotifications(open)
  const markRead = useMarkRead()
  const ago = useRelativeTime()
  const items = list.data?.items ?? []
  const unread = list.data?.unread ?? 0

  function openItem(item: AppNotification) {
    if (!item.read) markRead.mutate([item.id])
    onOpenChange(false)
    if (item.link) router.push(item.link)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup className="max-w-md" data-testid="notifications-panel">
        <SheetHeader>
          <div className="flex items-center justify-between gap-3 pe-8">
            <SheetTitle className="font-display text-xl">{t("notifications.title")}</SheetTitle>
            {unread > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                loading={markRead.isPending}
                onClick={() => markRead.mutate("all")}
              >
                <CheckCheckIcon />
                {t("notifications.markAllRead")}
              </Button>
            ) : null}
          </div>
          <SheetDescription className="sr-only">{t("notifications.title")}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="p-0">
          {list.isPending ? (
            <div className="grid place-items-center py-16">
              <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-foreground-muted">
              <BellIcon className="size-6" />
              {t("notifications.empty")}
            </div>
          ) : (
            <ul className="border-t">
              {items.map((item) => (
                <li key={item.id} className="border-b">
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    data-testid="notification-item"
                    className={cn(
                      "flex w-full cursor-pointer gap-3 px-6 py-3.5 text-start transition-colors hover:bg-surface-hover",
                      !item.read && "bg-brand-surface-subtle",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        item.read ? "bg-transparent" : "bg-brand",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-sm",
                          item.read ? "text-foreground-secondary" : "font-medium text-foreground",
                        )}
                      >
                        {item.text}
                      </span>
                      <span className="mt-0.5 block text-xs text-foreground-muted">
                        {item.workspace ? `${item.workspace} · ` : ""}
                        {ago(item.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  )
}
