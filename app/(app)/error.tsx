"use client"

import { Button } from "@/components/ui/button"
import { useLocale } from "@/lib/i18n/locale-provider"

/** Last-resort screen: show what broke and offer a way out. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useLocale()
  return (
    <div className="mx-auto max-w-lg py-24 text-center">
      <h1 className="font-display text-3xl">{t("errors.screenTitle")}</h1>
      <p className="mt-2 text-sm text-foreground-secondary">{t("errors.screenHint")}</p>
      <pre className="mt-6 overflow-x-auto rounded-md border bg-surface-muted p-3 text-start text-xs whitespace-pre-wrap">
        {error.message}
      </pre>
      <div className="mt-6 flex justify-center gap-2">
        <Button variant="outline" onClick={reset}>
          {t("errors.retry")}
        </Button>
        <Button variant="ghost" onClick={() => window.location.assign("/")}>
          {t("errors.reload")}
        </Button>
      </div>
    </div>
  )
}
