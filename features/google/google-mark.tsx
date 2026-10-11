"use client"

import { useLocale } from "@/lib/i18n/locale-provider"
import { cn } from "@/lib/utils"

/** Small "G" badge that tells a personal Google item apart from workspace items. */
export function GoogleMark({ className }: { className?: string }): React.ReactElement {
  const { t } = useLocale()
  return (
    <span
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center rounded-[3px] border border-current/30 font-sans text-[9px] leading-none font-bold opacity-70",
        className,
      )}
      dir="ltr"
    >
      <span aria-hidden="true">G</span>
      <span className="sr-only">{t("google.mark")}</span>
    </span>
  )
}

/** Inline-start colour bar for a personal event: its calendar's colour, or a neutral line. */
export function eventBarStyle(color: string | null): React.CSSProperties {
  return { borderInlineStartColor: color ?? "var(--foreground-muted)" }
}
