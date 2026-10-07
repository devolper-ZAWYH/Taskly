"use client"

import { DownloadIcon, ShareIcon, SquarePlusIcon, XIcon } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { useLocale } from "@/lib/i18n/locale-provider"
import { isIOS, isStandalone, promptInstall, useInstallState } from "@/lib/install"

const DISMISSED_KEY = "tasks:install-dismissed-at"
/** After "Not now", wait this long before asking again. */
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000
/** Let the page settle before asking. */
const DELAY_MS = 3000

function recentlyDismissed(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISSED_KEY) ?? 0) < SNOOZE_MS
  } catch {
    return false
  }
}

function rememberDismissal(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // Storage blocked: we may ask again next visit, which is harmless.
  }
}

/**
 * Registers the service worker and asks people whether to install the app:
 * the browser's own install dialog where supported (Chrome, Edge, Android),
 * Share → Add to Home Screen instructions on iPhone/iPad.
 */
/** Browser-only facts, read once on the client (false during server render). */
type ClientFacts = { ios: boolean; dismissed: boolean }
const SERVER_FACTS: ClientFacts = { ios: false, dismissed: true }
let clientFacts: ClientFacts | null = null
const noopSubscribe = () => () => {}
function readClientFacts(): ClientFacts {
  clientFacts ??= { ios: isIOS(), dismissed: isStandalone() || recentlyDismissed() }
  return clientFacts
}

export function InstallPrompt(): React.ReactElement | null {
  const { t } = useLocale()
  const install = useInstallState()
  const facts = React.useSyncExternalStore(noopSubscribe, readClientFacts, () => SERVER_FACTS)
  const ios = facts.ios
  const [ready, setReady] = React.useState(false)
  const [justDismissed, setJustDismissed] = React.useState(false)
  const dismissed = facts.dismissed || justDismissed

  React.useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {})
    }
    // Let the page settle before asking.
    const timer = setTimeout(() => setReady(true), DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  const mode =
    install.installed || dismissed || !ready
      ? "hidden"
      : install.canPrompt
        ? "prompt"
        : ios
          ? "ios"
          : "hidden"
  if (mode === "hidden") return null

  const dismiss = () => {
    rememberDismissal()
    setJustDismissed(true)
  }

  async function installNow() {
    const outcome = await promptInstall()
    if (outcome === "dismissed") dismiss()
  }

  return (
    <div
      role="dialog"
      aria-labelledby="install-title"
      data-testid="install-prompt"
      className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg sm:inset-x-auto sm:end-6 sm:w-96 md:bottom-6"
    >
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny static icon */}
        <img src="/icons/icon-192.png" alt="" className="size-11 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1">
          <p id="install-title" className="font-display text-base">
            {t("install.title")}
          </p>
          {mode === "ios" ? (
            <p className="mt-1 text-sm text-foreground-secondary">
              {t("install.iosBefore")}
              <ShareIcon
                className="mx-1 inline size-4 align-text-bottom"
                aria-label={t("install.share")}
              />
              {t("install.iosMiddle")}
              <SquarePlusIcon className="mx-1 inline size-4 align-text-bottom" aria-hidden="true" />
              <strong className="font-medium text-foreground">{t("install.iosAction")}</strong>.
            </p>
          ) : (
            <p className="mt-1 text-sm text-foreground-secondary">{t("install.body")}</p>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("common.close")}
          className="-me-1 -mt-1 cursor-pointer rounded-md p-1 text-foreground-muted hover:bg-surface-hover hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {mode === "ios" ? (
          <Button size="sm" onClick={dismiss}>
            {t("install.gotIt")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={dismiss}>
              {t("install.notNow")}
            </Button>
            <Button size="sm" onClick={() => void installNow()}>
              <DownloadIcon />
              {t("install.install")}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
