"use client"

import { useQueryClient } from "@tanstack/react-query"
import {
  CircleCheckIcon,
  ListChecksIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import {
  googleKeys,
  useDisconnectGoogle,
  useGoogleContainers,
  useGoogleStatus,
  useSetGoogleContainerSelected,
  useSyncGoogleNow,
} from "@/features/google/hooks"
import { GOOGLE_CONNECT_URL } from "@/lib/api/google"
import { useLocale, type MessageKey } from "@/lib/i18n/locale-provider"
import type { GoogleContainer, GoogleContainerKind, GoogleStatus } from "@/lib/types"

/** Settings → Google: connect, choose what shows, sync now, disconnect. */
export function GoogleSettings(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const status = useGoogleStatus()

  return (
    <div data-testid="google-settings">
      <CallbackNotice />
      {status.isPending ? (
        <Skeleton className="h-28 w-full rounded-md" />
      ) : status.isError ? (
        <p className="text-sm text-foreground-muted">{errorMessage(status.error)}</p>
      ) : !status.data.configured ? (
        <p className="text-sm text-foreground-muted">{t("google.settings.notConfigured")}</p>
      ) : status.data.connected ? (
        <Connected status={status.data} />
      ) : status.data.state === "revoked" || status.data.state === "error" ? (
        <Problem status={status.data} />
      ) : (
        <NotConnected />
      )}
    </div>
  )
}

const CALLBACK_ERRORS: Record<string, MessageKey> = {
  denied: "google.settings.callback.denied",
  scopes: "google.settings.callback.scopes",
  unconfigured: "google.settings.callback.unconfigured",
  failed: "google.settings.callback.failed",
}

/** Google's consent screen returns to `/settings?google=…`: say how it went, then tidy the URL. */
function CallbackNotice(): null {
  const { t } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const result = searchParams.get("google")
  const reason = searchParams.get("reason")
  const handled = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!result) return
    const signature = `${result}:${reason}`
    if (handled.current === signature) return
    handled.current = signature

    if (result === "connected") {
      toastManager.add({ type: "success", title: t("google.settings.callback.connected") })
      void queryClient.invalidateQueries({ queryKey: googleKeys.all })
    } else if (result === "error") {
      toastManager.add({
        type: "error",
        title: t(CALLBACK_ERRORS[reason ?? ""] ?? "google.settings.callback.failed"),
      })
    }
    const params = new URLSearchParams(searchParams.toString())
    params.delete("google")
    params.delete("reason")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [result, reason, searchParams, pathname, router, queryClient, t])

  return null
}

function NotConnected(): React.ReactElement {
  const { t } = useLocale()
  const points: MessageKey[] = [
    "google.settings.pointWorkspace",
    "google.settings.pointPersonal",
    "google.settings.pointBothWays",
  ]
  return (
    <div className="flex flex-col gap-4 rounded-md border p-4">
      <p className="text-sm font-medium">{t("google.settings.intro")}</p>
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm text-foreground-secondary">
        {points.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <div>
        {/* A real link: Google's consent screen needs a full-page navigation. */}
        <Button render={<a href={GOOGLE_CONNECT_URL} />} data-testid="google-connect">
          {t("google.settings.connect")}
        </Button>
      </div>
    </div>
  )
}

/** Google refused the saved access, or syncing broke: say so and offer to reconnect. */
function Problem({ status }: { status: GoogleStatus }): React.ReactElement {
  const { t } = useLocale()
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive-bg p-4"
      data-testid="google-problem"
    >
      <p className="flex items-start gap-2 text-sm text-destructive-foreground">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {status.state === "revoked" ? t("google.settings.revoked") : t("google.settings.error")}
      </p>
      {status.state === "error" && status.lastError ? (
        <p dir="auto" className="text-xs break-words text-foreground-secondary">
          {t("google.settings.errorDetail", { error: status.lastError })}
        </p>
      ) : null}
      <div>
        <Button size="sm" render={<a href={GOOGLE_CONNECT_URL} />}>
          {t("google.settings.reconnect")}
        </Button>
      </div>
    </div>
  )
}

function Connected({ status }: { status: GoogleStatus }): React.ReactElement {
  const { t, errorMessage, formatDateTime } = useLocale()
  const sync = useSyncGoogleNow()
  const disconnect = useDisconnectGoogle()
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false)
  const problem = status.state === "revoked" || status.state === "error"
  // Without access there's nothing to list or sync until they reconnect.
  const usable = status.state !== "revoked"

  return (
    <div className="flex flex-col gap-6">
      {problem ? <Problem status={status} /> : null}

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-md border p-4">
        <div className="flex min-w-0 gap-3">
          {problem ? (
            <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-destructive" />
          ) : (
            <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              <span dir="ltr">{status.email}</span>
            </p>
            <p className="mt-0.5 text-xs text-foreground-muted" data-testid="google-last-sync">
              {status.lastSyncAt
                ? t("google.settings.lastSync", { date: formatDateTime(status.lastSyncAt) })
                : t("google.settings.neverSynced")}
            </p>
            {status.failedJobs > 0 ? (
              <p className="mt-1 text-xs text-destructive" data-testid="google-failed-jobs">
                {t("google.settings.failedJobs")}
              </p>
            ) : null}
          </div>
        </div>
        {usable ? (
          <Button
            size="sm"
            variant="outline"
            loading={sync.isPending}
            onClick={() =>
              sync.mutate(true, {
                onSuccess: () =>
                  toastManager.add({ type: "success", title: t("google.settings.synced") }),
                onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
              })
            }
          >
            <RefreshCwIcon />
            {t("google.settings.syncNow")}
          </Button>
        ) : null}
      </div>

      {usable ? <Containers /> : null}

      <div>
        <Button
          size="sm"
          variant="destructive-outline"
          onClick={() => setConfirmDisconnect(true)}
          data-testid="google-disconnect"
        >
          <UnplugIcon />
          {t("google.settings.disconnect")}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t("google.settings.disconnectTitle")}
        description={t("google.settings.disconnectBody")}
        confirmLabel={t("google.settings.disconnect")}
        onConfirm={async () => {
          await disconnect.mutateAsync()
          toastManager.add({ type: "success", title: t("google.settings.disconnected") })
        }}
      />
    </div>
  )
}

/** Personal calendars and lists get a switch; "Taskly · …" ones always sync. */
function Containers(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const containers = useGoogleContainers({ refresh: true, enabled: true })

  if (containers.isPending) {
    return <Skeleton className="h-40 w-full rounded-md" />
  }
  if (containers.isError) {
    return <p className="text-sm text-foreground-muted">{errorMessage(containers.error)}</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-foreground-muted">{t("google.settings.showHint")}</p>
      <ContainerGroup
        kind="calendar"
        title={t("google.settings.calendars")}
        items={containers.data}
      />
      <ContainerGroup
        kind="tasklist"
        title={t("google.settings.taskLists")}
        items={containers.data}
      />
    </div>
  )
}

function ContainerGroup({
  kind,
  title,
  items,
}: {
  kind: GoogleContainerKind
  title: string
  items: GoogleContainer[]
}): React.ReactElement {
  const { t } = useLocale()
  // Personal first (main one on top), then the workspace copies.
  const rows = items
    .filter((c) => c.kind === kind)
    .sort(
      (a, b) =>
        Number(a.accountId !== null) - Number(b.accountId !== null) ||
        Number(b.primary) - Number(a.primary),
    )

  return (
    <div className="overflow-hidden rounded-md border" data-testid={`google-${kind}s`}>
      <p className="eyebrow border-b bg-surface-muted px-4 py-2">{title}</p>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-foreground-muted">{t("google.settings.none")}</p>
      ) : (
        rows.map((c) => <ContainerRow key={c.id} container={c} />)
      )}
    </div>
  )
}

function ContainerRow({ container }: { container: GoogleContainer }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const setSelected = useSetGoogleContainerSelected()
  const workspace = container.accountId !== null
  // Show the new position while Google is being told.
  const checked = setSelected.isPending ? setSelected.variables.selected : container.selected

  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
      {container.kind === "calendar" ? (
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-full border border-foreground/10"
          style={{ background: container.color ?? "var(--foreground-muted)" }}
        />
      ) : (
        <ListChecksIcon className="size-4 shrink-0 text-foreground-muted" aria-hidden="true" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span dir="auto" className="truncate text-sm">
          {container.title}
        </span>
        {container.primary ? (
          <span className="text-xs text-foreground-muted">
            {container.kind === "calendar"
              ? t("google.settings.primaryCalendar")
              : t("google.settings.defaultList")}
          </span>
        ) : null}
      </span>
      {workspace ? (
        <span className="shrink-0 text-xs text-foreground-muted">
          {t("google.settings.automatic")}
        </span>
      ) : (
        <Switch
          aria-label={container.title}
          checked={checked}
          onCheckedChange={(selected) =>
            setSelected.mutate(
              { kind: container.kind, id: container.id, selected },
              {
                onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
              },
            )
          }
        />
      )}
    </div>
  )
}
