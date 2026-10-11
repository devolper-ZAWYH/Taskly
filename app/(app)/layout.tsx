"use client"

import { Loader2Icon } from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"
import { MobileBottomNav, MobileTopNav } from "@/components/shell/mobile-nav"
import { Sidebar } from "@/components/shell/sidebar"
import { SidebarCollapseProvider } from "@/components/shell/sidebar-collapse"
import { NotificationsProvider } from "@/features/notifications/notifications-panel"
import { useMe } from "@/features/auth/use-auth"
import { GoogleSyncOnOpen } from "@/features/google/sync-on-open"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const me = useMe()
  const signedOut = me.isFetched && !me.data

  React.useEffect(() => {
    if (signedOut) router.replace("/login")
  }, [signedOut, router])

  if (!me.data) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
      </div>
    )
  }

  return (
    <SidebarCollapseProvider>
      <NotificationsProvider>
        <GoogleSyncOnOpen />
        <div className="flex min-h-svh">
          <Sidebar />
          <div className="flex w-0 min-w-0 flex-1 flex-col">
            <MobileTopNav />
            <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-10">{children}</main>
            <MobileBottomNav />
          </div>
        </div>
      </NotificationsProvider>
    </SidebarCollapseProvider>
  )
}
