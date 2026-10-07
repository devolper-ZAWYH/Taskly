"use client"

import { BellOffIcon, BellRingIcon } from "lucide-react"
import * as React from "react"
import { FormError } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import { useNotificationPrefs, useSetNotificationPref } from "@/features/notifications/hooks"
import { useLocale } from "@/lib/i18n/locale-provider"
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/push"
import { NOTIFICATION_KINDS, type NotificationChannel } from "@/lib/types"

/** Per-type switches for in-app and push, plus push on/off for this device. */
export function NotificationSettings(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const prefs = useNotificationPrefs()
  const setPref = useSetNotificationPref()

  return (
    <div className="flex flex-col gap-6">
      <DevicePush />
      <div className="overflow-hidden rounded-md border" data-testid="notification-prefs">
        <div className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-2 border-b bg-surface-muted px-4 py-2">
          <span className="eyebrow">{t("notifications.type")}</span>
          <span className="eyebrow text-center">{t("notifications.inApp")}</span>
          <span className="eyebrow text-center">{t("notifications.push")}</span>
        </div>
        {NOTIFICATION_KINDS.map((kind) => (
          <div
            key={kind}
            className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-2 border-b px-4 py-3 last:border-b-0"
          >
            <span className="text-sm">{t(`notifications.kinds.${kind}`)}</span>
            {(["inApp", "push"] as NotificationChannel[]).map((channel) => (
              <span key={channel} className="flex justify-center">
                <Switch
                  aria-label={`${t(`notifications.kinds.${kind}`)} · ${t(`notifications.${channel}`)}`}
                  checked={prefs.data?.[kind][channel] ?? true}
                  disabled={!prefs.data}
                  onCheckedChange={(enabled) => setPref.mutate({ kind, channel, enabled })}
                />
              </span>
            ))}
          </div>
        ))}
      </div>
      <FormError message={setPref.error ? errorMessage(setPref.error) : null} />
    </div>
  )
}

function DevicePush(): React.ReactElement {
  const { t } = useLocale()
  const [state, setState] = React.useState<PushState | null>(null)
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    void getPushState().then(setState)
  }, [])

  async function toggle() {
    setPending(true)
    try {
      if (state === "on") {
        await disablePush()
        setState("off")
        toastManager.add({ type: "success", title: t("notifications.pushDisabled") })
      } else {
        const next = await enablePush()
        setState(next)
        if (next === "on")
          toastManager.add({ type: "success", title: t("notifications.pushEnabled") })
      }
    } catch {
      setState(await getPushState())
    } finally {
      setPending(false)
    }
  }

  const message =
    state === "on"
      ? t("notifications.pushOn")
      : state === "blocked"
        ? t("notifications.pushBlocked")
        : state === "unsupported"
          ? t("notifications.pushUnsupported")
          : state === "ios-install"
            ? t("notifications.pushIosInstall")
            : state === "unavailable"
              ? t("notifications.pushUnavailable")
              : t("notifications.pushOff")
  const canToggle = state === "on" || state === "off"

  return (
    <div
      className="flex items-start justify-between gap-4 rounded-md border p-4"
      data-testid="device-push"
    >
      <div className="flex gap-3">
        {state === "on" ? (
          <BellRingIcon className="mt-0.5 size-5 shrink-0 text-success" />
        ) : (
          <BellOffIcon className="mt-0.5 size-5 shrink-0 text-foreground-muted" />
        )}
        <div>
          <p className="text-sm font-medium">{t("notifications.device")}</p>
          <p className="mt-0.5 text-xs text-foreground-muted">{state ? message : "…"}</p>
        </div>
      </div>
      {canToggle ? (
        <Button
          size="sm"
          variant={state === "on" ? "outline" : "default"}
          loading={pending}
          onClick={() => void toggle()}
        >
          {state === "on" ? t("notifications.disablePush") : t("notifications.enablePush")}
        </Button>
      ) : null}
    </div>
  )
}
