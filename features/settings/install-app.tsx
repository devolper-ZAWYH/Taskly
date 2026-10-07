"use client"

import { CircleCheckIcon, DownloadIcon, ShareIcon, SquarePlusIcon } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import { useLocale } from "@/lib/i18n/locale-provider"
import { isIOS, promptInstall, useInstallState } from "@/lib/install"

const noopSubscribe = () => () => {}

/**
 * Install Taskly from Settings — works even if the pop-up card was dismissed:
 * the browser's own dialog where offered, Share → Add to Home Screen on
 * iPhone/iPad, and a pointer to the browser menu elsewhere.
 */
export function InstallApp(): React.ReactElement {
  const { t } = useLocale()
  const install = useInstallState()
  const ios = React.useSyncExternalStore(noopSubscribe, isIOS, () => false)
  const [pending, setPending] = React.useState(false)

  async function installNow() {
    setPending(true)
    try {
      if ((await promptInstall()) === "accepted") {
        toastManager.add({ type: "success", title: t("install.done") })
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-start gap-4 rounded-md border p-4" data-testid="install-app">
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static icon */}
      <img src="/icons/icon-192.png" alt="" className="size-12 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        {install.installed ? (
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <CircleCheckIcon className="size-4 text-success" />
            {t("install.installed")}
          </p>
        ) : install.canPrompt ? (
          <>
            <p className="text-sm font-medium">{t("install.title")}</p>
            <p className="mt-0.5 text-xs text-foreground-muted">{t("install.body")}</p>
            <Button className="mt-3" size="sm" loading={pending} onClick={() => void installNow()}>
              <DownloadIcon />
              {t("install.install")}
            </Button>
          </>
        ) : ios ? (
          <>
            <p className="text-sm font-medium">{t("install.title")}</p>
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
          </>
        ) : (
          <>
            <p className="text-sm font-medium">{t("install.title")}</p>
            <p className="mt-1 text-xs text-foreground-muted">{t("install.menuHint")}</p>
          </>
        )}
      </div>
    </div>
  )
}
