"use client"

import { RefreshCwIcon } from "lucide-react"
import { useGoogleConnected, useGoogleTasks } from "@/features/google/hooks"
import { useLocale } from "@/lib/i18n/locale-provider"

/**
 * "Synced to Google" under a workspace task or meeting, shown when the viewer
 * is connected and the item is one Taskly copies into their Google account
 * (`involved`: they're an assignee, attendee or the organiser).
 */
export function SyncedToGoogle({
  involved,
  kind,
}: {
  involved: boolean
  kind: "task" | "meeting"
}): React.ReactElement | null {
  const { t } = useLocale()
  const connected = useGoogleConnected()
  const tasks = useGoogleTasks()
  if (!(kind === "task" ? tasks : connected) || !involved) return null
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-foreground-muted"
      data-testid="synced-to-google"
    >
      <RefreshCwIcon className="size-3 shrink-0" aria-hidden="true" />
      {t("google.synced")}
    </p>
  )
}
