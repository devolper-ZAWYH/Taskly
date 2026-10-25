"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckIcon, CopyIcon, MonitorIcon, TriangleAlertIcon, Trash2Icon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError, FormRow } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { toastManager } from "@/components/ui/toast"
import { useMyWorkspaces } from "@/features/workspace/workspace-context"
import { createLiveDeviceToken, deleteLiveDeviceToken, liveDeviceTokens } from "@/lib/api/live"
import { useLocale } from "@/lib/i18n/locale-provider"

const LIVE_TOKENS_KEY = ["live-device-tokens"] as const

/**
 * Settings → Live capture: name a recording device (a PC running the Taskly
 * engine), get its token once, and revoke it later. Tokens belong to one
 * person and one workspace.
 */
export function LiveCapture(): React.ReactElement {
  const { t, errorMessage, formatDateTime } = useLocale()
  const queryClient = useQueryClient()
  const devices = useQuery({ queryKey: LIVE_TOKENS_KEY, queryFn: liveDeviceTokens })
  const workspaces = useMyWorkspaces()
  const memberships = (workspaces.data ?? []).filter((entry) => !entry.viaOperator)

  const [name, setName] = React.useState("")
  const [workspaceId, setWorkspaceId] = React.useState<string | undefined>(undefined)
  // The raw token stays in state until the panel is closed. Only its hash is
  // stored server-side, so closing (or losing) it means making a new one.
  const [given, setGiven] = React.useState<string | null>(null)
  const [revoking, setRevoking] = React.useState<string | null>(null)

  // Resolved when the mutation runs, so a slow workspace list can't create a
  // token for the wrong workspace.
  const chosen = workspaceId ?? memberships[0]?.account.id
  const created = (message: string) => {
    setName("")
    void queryClient.invalidateQueries({ queryKey: LIVE_TOKENS_KEY })
    toastManager.add({ type: "success", title: message })
  }
  const failed = (error: Error) => toastManager.add({ type: "error", title: errorMessage(error) })

  const create = useMutation({
    mutationFn: () => createLiveDeviceToken({ name: name.trim(), workspaceId: chosen }),
    onSuccess: (result) => {
      setGiven(result.token)
      created(t("live.tokens.created", { name: result.device.name }))
    },
    onError: failed,
  })
  const revoke = useMutation({
    mutationFn: deleteLiveDeviceToken,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LIVE_TOKENS_KEY })
      setRevoking(null)
    },
    onError: failed,
  })

  if (devices.isPending) return <Skeleton className="h-40 w-full rounded-md" />
  if (devices.isError) return <FormError message={errorMessage(devices.error)} />
  const list = devices.data
  const several = memberships.length > 1

  return (
    <div className="flex flex-col gap-6" data-testid="live-capture">
      {given ? (
        <TokenSecret token={given} onClose={() => setGiven(null)} />
      ) : (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <FormRow label={t("live.tokens.nameLabel")} htmlFor="live-device-name">
            <Input
              id="live-device-name"
              dir="ltr"
              maxLength={50}
              placeholder={t("live.tokens.namePlaceholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </FormRow>
          {several && memberships.length > 0 ? (
            <FormRow label={t("live.tokens.workspace")}>
              <Select
                value={chosen}
                disabled={create.isPending}
                onValueChange={(value) => value && setWorkspaceId(value)}
              >
                <SelectTrigger>
                  <span className="truncate">
                    {memberships.find((entry) => entry.account.id === chosen)?.account.name}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {memberships.map((entry) => (
                    <SelectItem key={entry.account.id} value={entry.account.id}>
                      {entry.account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRow>
          ) : null}
          <FormError message={create.error ? errorMessage(create.error) : null} />
          <div>
            <Button type="submit" variant="outline" loading={create.isPending} disabled={!name.trim()}>
              {t("live.tokens.create")}
            </Button>
          </div>
          <p className="text-xs text-foreground-muted">{t("live.tokens.hint")}</p>
        </form>
      )}

      {list.length > 0 ? (
        <ul className="rounded-md border" data-testid="live-devices">
          {list.map((device, index) => (
            <li
              key={device.id}
              className={`flex items-center gap-3 px-3 py-2.5 ${index > 0 ? "border-t" : ""}`}
            >
              <MonitorIcon className="size-4 shrink-0 text-foreground-muted" />
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block truncate text-sm font-medium">
                  {device.name}
                </span>
                <span className="block truncate text-xs text-foreground-muted">
                  {device.workspace} ·{" "}
                  {t("live.tokens.lastUsed", { date: formatDateTime(device.lastUsed) })}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive-foreground"
                aria-label={`${t("live.tokens.revoke")} ${device.name}`}
                onClick={() => setRevoking(device.id)}
              >
                <Trash2Icon />
                <span className="max-sm:sr-only">{t("live.tokens.revoke")}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-foreground-muted">
          {t("live.tokens.empty")}
        </p>
      )}

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("live.tokens.revokeTitle", {
          name: list.find((device) => device.id === revoking)?.name ?? "",
        })}
        description={t("live.tokens.revokeBody")}
        confirmLabel={t("live.tokens.revoke")}
        onConfirm={async () => {
          if (!revoking) return
          const device = list.find((entry) => entry.id === revoking)
          await revoke.mutateAsync(revoking)
          toastManager.add({ type: "success", title: t("live.tokens.revoked", { name: device?.name ?? "" }) })
        }}
      />
    </div>
  )
}

/**
 * The raw token, shown exactly once and copyable. The server keeps its
 * SHA-256, so it can never be shown again — losing it means a new token.
 */
function TokenSecret({ token, onClose }: { token: string; onClose: () => void }): React.ReactElement {
  const { t } = useLocale()
  const [copied, setCopied] = React.useState(false)
  const copy = () => {
    void navigator.clipboard
      .writeText(token)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => toastManager.add({ type: "error", title: t("live.tokens.copyFailed") }))
  }
  return (
    <div className="flex flex-col gap-3" data-testid="live-token-secret">
      <p className="flex gap-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-foreground">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        {t("live.tokens.tokenHint")}
      </p>
      <div className="flex gap-2">
        <Input
          value={token}
          readOnly
          dir="ltr"
          aria-label={t("live.tokens.tokenTitle")}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t("live.tokens.copied") : t("live.tokens.copy")}
        </Button>
      </div>
      <div>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("live.tokens.done")}
        </Button>
      </div>
    </div>
  )
}
