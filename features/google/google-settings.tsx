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
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import {
  googleKeys,
  useDisconnectGoogle,
  useGoogleContainers,
  useGoogleStatus,
  useSetGoogleCalendarAutoAdd,
  useSetGoogleContainerSelected,
  useSyncGoogleNow,
} from "@/features/google/hooks"
import { useMyWorkspaces } from "@/features/workspace/workspace-context"
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
        <NotConnected tasks={status.data.tasksEnabled} />
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

/** `tasks`: tasks sync with Google Tasks on this server; otherwise only meetings and events. */
function NotConnected({ tasks }: { tasks: boolean }): React.ReactElement {
  const { t } = useLocale()
  const points: MessageKey[] = tasks
    ? ["google.settings.pointWorkspace", "google.settings.pointPersonal", "google.settings.pointBothWays"]
    : [
        "google.settings.pointWorkspaceCalendar",
        "google.settings.pointPersonalCalendar",
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

      {usable && status.tasksEnabled && !status.tasks ? (
        // Tasks sync was switched on after they connected: Google Tasks needs their OK.
        <div
          className="flex flex-col gap-3 rounded-md border border-brand-border bg-brand-surface-subtle p-4"
          data-testid="google-tasks-reconnect"
        >
          <p className="text-sm">{t("google.settings.tasksReconnect")}</p>
          <div>
            <Button size="sm" render={<a href={GOOGLE_CONNECT_URL} />}>
              {t("google.settings.reconnect")}
            </Button>
          </div>
        </div>
      ) : null}

      {usable ? <Containers tasks={status.tasks} /> : null}

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

/** Personal calendars and lists get a switch; "Taskly · …" ones always sync. Lists only with tasks sync. */
function Containers({ tasks }: { tasks: boolean }): React.ReactElement {
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
      <p className="text-xs text-foreground-muted">
        {t(tasks ? "google.settings.showHint" : "google.settings.showHintCalendar")}
      </p>
      <ContainerGroup
        kind="calendar"
        title={t("google.settings.calendars")}
        items={containers.data}
      />
      {tasks ? (
        <ContainerGroup
          kind="tasklist"
          title={t("google.settings.taskLists")}
          items={containers.data}
        />
      ) : null}
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
    <div className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
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
      {container.kind === "calendar" && !workspace ? <AutoAdd container={container} /> : null}
    </div>
  )
}

const AUTO_OFF = "off"

/**
 * Under each of their own calendars, for administrators: add the work meetings
 * in it (events with someone from that workspace) to a workspace every hour.
 */
function AutoAdd({ container }: { container: GoogleContainer }): React.ReactElement | null {
  const { t, errorMessage } = useLocale()
  const workspaces = useMyWorkspaces()
  const setAuto = useSetGoogleCalendarAutoAdd()
  const admin = (workspaces.data ?? []).filter((w) => w.role === "administrator" && !w.viaOperator)
  if (admin.length === 0) return null
  const value = setAuto.isPending ? (setAuto.variables.accountId ?? AUTO_OFF) : (container.autoAccountId ?? AUTO_OFF)
  const label = (id: string) =>
    id === AUTO_OFF ? t("google.settings.autoAddOff") : (admin.find((w) => w.account.id === id)?.account.name ?? "")

  return (
    <div className="flex flex-col gap-1 ps-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-foreground-muted">{t("google.settings.autoAdd")}</span>
        <Select
          value={value}
          onValueChange={(next) =>
            next &&
            setAuto.mutate(
              { calendarId: container.id, accountId: next === AUTO_OFF ? null : (next as string) },
              { onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }) },
            )
          }
        >
          <SelectTrigger size="sm" className="w-auto min-w-40" aria-label={t("google.settings.autoAdd")}>
            <span>{label(value)}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_OFF}>{t("google.settings.autoAddOff")}</SelectItem>
            {admin.map((w) => (
              <SelectItem key={w.account.id} value={w.account.id}>
                {w.account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {container.autoAccountId ? (
        <p className="text-xs text-foreground-muted">{t("google.settings.autoAddHint")}</p>
      ) : null}
    </div>
  )
}
