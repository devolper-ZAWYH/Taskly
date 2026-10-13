"use client"

import { XIcon } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { ClaudeMark } from "@/components/shell/claude-mark"
import { Button } from "@/components/ui/button"
import { useClaudeSetup } from "@/features/connector/hooks"
import { useLocale } from "@/lib/i18n/locale-provider"
import { getClaudeCardDismissed, setClaudeCardDismissed } from "@/lib/preferences"

// The dismissal lives in localStorage; these let React re-read it after a click.
const listeners = new Set<() => void>()
let dismissedNow = false
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const readDismissed = () => dismissedNow || getClaudeCardDismissed()

/**
 * Dashboard nudge to connect Claude, until the person has connected it or
 * dismissed the card (remembered on this device only).
 */
export function ConnectClaudeCard(): React.ReactElement | null {
  const { t } = useLocale()
  const setup = useClaudeSetup()
  // Hidden while server-rendering, so a dismissed card never flashes.
  const dismissed = React.useSyncExternalStore(subscribe, readDismissed, () => true)

  function dismiss() {
    dismissedNow = true
    setClaudeCardDismissed()
    listeners.forEach((listener) => listener())
  }

  const data = setup.data
  if (dismissed || !data?.available || !data.publicUrl || data.connections.length > 0) return null
  return (
    <div className="flex items-center gap-4 rounded-md border p-4" data-testid="connect-claude-card">
      <ClaudeMark className="size-9" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t("claude.card.title")}</p>
        <p className="text-xs text-foreground-muted">{t("claude.card.body")}</p>
      </div>
      <Button size="sm" render={<Link href="/settings#claude" />}>
        {t("claude.card.setUp")}
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={t("claude.card.dismiss")} onClick={dismiss}>
        <XIcon />
      </Button>
    </div>
  )
}
