"use client"

import * as React from "react"
import { useMediaQuery } from "@/lib/use-media-query"

const STORAGE_KEY = "tasks-proto:sidebar-collapsed"
const CHANGE_EVENT = "sidebar-collapse-change"

type SidebarCollapseValue = {
  isCollapsed: boolean
  /** Rail mode: collapsed by the user, or forced on tablet widths. */
  isIconOnly: boolean
  mounted: boolean
  toggleCollapsed: () => void
  expandSidebar: () => void
}

const SidebarCollapseContext = React.createContext<SidebarCollapseValue | null>(null)

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // Storage unavailable: the choice just won't survive a reload.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener("storage", onChange)
  }
}

const noopSubscribe = () => () => {}

export function SidebarCollapseProvider({ children }: { children: React.ReactNode }) {
  const isTablet = useMediaQuery("(max-width: 1024px)")
  const mounted = React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
  const isCollapsed = React.useSyncExternalStore(subscribe, readCollapsed, () => false)
  const isIconOnly = mounted && (isTablet || isCollapsed)

  const value = React.useMemo<SidebarCollapseValue>(
    () => ({
      isCollapsed,
      isIconOnly,
      mounted,
      toggleCollapsed: () => writeCollapsed(!readCollapsed()),
      expandSidebar: () => writeCollapsed(false),
    }),
    [isCollapsed, isIconOnly, mounted],
  )

  return <SidebarCollapseContext.Provider value={value}>{children}</SidebarCollapseContext.Provider>
}

export function useSidebarCollapse(): SidebarCollapseValue {
  const context = React.useContext(SidebarCollapseContext)
  if (!context) throw new Error("useSidebarCollapse must be used within SidebarCollapseProvider")
  return context
}
