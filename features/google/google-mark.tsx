"use client"

import { GoogleLogo } from "@/components/shell/google-logo"
import { useLocale } from "@/lib/i18n/locale-provider"
import { cn } from "@/lib/utils"

/** Google's "G" next to a personal Google item, telling it apart from workspace items. */
export function GoogleMark({ className }: { className?: string }): React.ReactElement {
  const { t } = useLocale()
  return (
    <span className={cn("inline-flex shrink-0", className)}>
      <GoogleLogo className="size-3.5" />
      <span className="sr-only">{t("google.mark")}</span>
    </span>
  )
}

/** Inline-start colour bar for a personal event: its calendar's colour, or a neutral line. */
export function eventBarStyle(color: string | null): React.CSSProperties {
  return { borderInlineStartColor: color ?? "var(--foreground-muted)" }
}
