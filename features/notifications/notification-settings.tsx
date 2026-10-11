"use client"

import { BellOffIcon, BellRingIcon } from "lucide-react"
import * as React from "react"
import { FormError } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import {
  useEmailAvailable,
  useNotificationPrefs,
  useSetNotificationPref,
} from "@/features/notifications/hooks"
import { useLocale } from "@/lib/i18n/locale-provider"
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/push"
import { NOTIFICATION_KINDS, type NotificationChannel } from "@/lib/types"

const CHANNELS: NotificationChannel[] = ["inApp", "push", "email"]
const GRID = "grid grid-cols-[1fr_3.75rem_3.75rem_3.75rem] items-center gap-2 sm:grid-cols-[1fr_4.5rem_4.5rem_4.5rem]"

/** Per-type switches for in-app, push and email, plus push on/off for this device. */
export function NotificationSettings(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const prefs = useNotificationPrefs()
  const setPref = useSetNotificationPref()
  // Email is off by default, and can't be switched on until the server can send it.
  const emailAvailable = useEmailAvailable().data === true

  return (
    <div className="flex flex-col gap-6">
      <DevicePush />
      <div className="overflow-hidden rounded-md border" data-testid="notification-prefs">
        <div className={`${GRID} border-b bg-surface-muted px-4 py-2`}>
          <span className="eyebrow">{t("notifications.type")}</span>
          {CHANNELS.map((channel) => (
            <span key={channel} className="eyebrow text-center">
              {t(`notifications.${channel}`)}
            </span>
          ))}
        </div>
        {NOTIFICATION_KINDS.map((kind) => (
          <div key={kind} className={`${GRID} border-b px-4 py-3 last:border-b-0`}>
            <span className="text-sm">{t(`notifications.kinds.${kind}`)}</span>
            {CHANNELS.map((channel) => (
              <span key={channel} className="flex justify-center">
                <Switch
                  aria-label={`${t(`notifications.kinds.${kind}`)} · ${t(`notifications.${channel}`)}`}
                  checked={
                    channel === "email"
                      ? emailAvailable && (prefs.data?.[kind].email ?? false)
                      : (prefs.data?.[kind][channel] ?? true)
                  }
                  disabled={!prefs.data || (channel === "email" && !emailAvailable)}
                  onCheckedChange={(enabled) => setPref.mutate({ kind, channel, enabled })}
                />
              </span>
            ))}
          </div>
        ))}
      </div>
      {!emailAvailable ? (
        <p className="-mt-3 text-xs text-foreground-muted" data-testid="email-unavailable">
          {t("notifications.emailUnavailable")}
        </p>
      ) : null}
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
