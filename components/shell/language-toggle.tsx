"use client"

import { useQueryClient } from "@tanstack/react-query"
import { ME_KEY, useMe } from "@/features/auth/use-auth"
import { updateMe } from "@/lib/api/auth"
import { useLocale } from "@/lib/i18n/locale-provider"
import { cn } from "@/lib/utils"

/** Switches language; when signed in, also saves it as the user's preference. */
export function useToggleLocale(): () => void {
  const { locale, setLocale } = useLocale()
  const queryClient = useQueryClient()
  const { data: me } = useMe()
  return () => {
    const next = locale === "ar" ? "en" : "ar"
    setLocale(next)
    if (me) void updateMe({ locale: next }).then((user) => queryClient.setQueryData(ME_KEY, user))
  }
}

export function LanguageToggle({ className }: { className?: string }): React.ReactElement {
  const { t } = useLocale()
  const toggle = useToggleLocale()
  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "h-8 cursor-pointer rounded-md border border-input px-3 text-xs font-semibold tracking-wide text-foreground transition-colors hover:border-foreground hover:bg-foreground hover:text-background",
        className,
      )}
    >
      {t("nav.language")}
    </button>
  )
}
