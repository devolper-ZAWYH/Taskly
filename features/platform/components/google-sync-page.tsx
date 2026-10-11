"use client"

import { RotateCcwIcon } from "lucide-react"
import * as React from "react"
import { FormError } from "@/components/shell/form-row"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toastManager } from "@/components/ui/toast"
import {
  useGoogleSyncHealth,
  useRetryFailedGoogleJobs,
} from "@/features/platform/hooks/use-platform"
import { useLocale, type MessageKey } from "@/lib/i18n/locale-provider"
import type { GoogleSyncHealth } from "@/lib/types"
import { cn } from "@/lib/utils"

const JOB_KINDS: Record<string, MessageKey> = {
  sync_task: "platform.google.kinds.sync_task",
  sync_meeting: "platform.google.kinds.sync_meeting",
  setup_user: "platform.google.kinds.setup_user",
  setup_member: "platform.google.kinds.setup_member",
  purge_member: "platform.google.kinds.purge_member",
  purge_user: "platform.google.kinds.purge_user",
  pull: "platform.google.kinds.pull",
}

/** Platform → Google sync: what's failing, who must reconnect, and a retry button. */
export function GoogleSyncPage(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const health = useGoogleSyncHealth()
  const retry = useRetryFailedGoogleJobs()

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={t("platform.eyebrow")}
        title={t("platform.google.title")}
        subtitle={t("platform.google.subtitle")}
        actions={
          <Button
            variant="outline"
            disabled={!health.data?.failed}
            loading={retry.isPending}
            onClick={() =>
              retry.mutate(undefined, {
                onSuccess: () =>
                  toastManager.add({ type: "success", title: t("platform.google.retried") }),
              })
            }
          >
            <RotateCcwIcon />
            {t("platform.google.retry")}
          </Button>
        }
      />
      <FormError message={retry.error ? errorMessage(retry.error) : null} />

      {health.isPending ? (
        <Skeleton className="h-24 w-full rounded-md" />
      ) : health.isError ? (
        <FormError message={errorMessage(health.error)} />
      ) : (
        <Health health={health.data} />
      )}
    </div>
  )
}

function Health({ health }: { health: GoogleSyncHealth }): React.ReactElement {
  const { t } = useLocale()
  if (!health.configured) {
    return <p className="text-sm text-foreground-muted">{t("google.settings.notConfigured")}</p>
  }
  const stats = [
    { label: t("platform.google.connections"), value: health.connections, alert: false },
    { label: t("platform.google.failed"), value: health.failed, alert: health.failed > 0 },
    { label: t("platform.google.retrying"), value: health.retrying, alert: false },
    { label: t("platform.google.queued"), value: health.queued, alert: false },
  ]
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="google-health-stats">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-md border p-4">
            <dt className="eyebrow">{stat.label}</dt>
            <dd
              className={cn(
                "font-display mt-1 text-2xl tabular-nums",
                stat.alert && "text-destructive",
              )}
            >
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
      <Jobs health={health} />
      <People health={health} />
    </>
  )
}

function Jobs({ health }: { health: GoogleSyncHealth }): React.ReactElement {
  const { t, formatDateTime } = useLocale()
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-xl">{t("platform.google.jobsTitle")}</h2>
        <p className="text-xs text-foreground-muted">{t("platform.google.jobsHint")}</p>
      </div>
      <div className="overflow-x-auto border-t">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className="eyebrow">{t("platform.google.columns.work")}</TableHead>
              <TableHead className="eyebrow hidden md:table-cell">
                {t("platform.google.columns.error")}
              </TableHead>
              <TableHead className="eyebrow w-40">{t("platform.google.columns.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {health.jobs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="h-24 text-center text-sm text-foreground-muted">
                  {t("platform.google.noJobs")}
                </TableCell>
              </TableRow>
            ) : null}
            {health.jobs.map((job) => (
              <TableRow key={job.id} className="hover:bg-transparent" data-testid="google-job-row">
                <TableCell className="py-3 align-top">
                  <span className="block truncate font-medium">
                    {JOB_KINDS[job.kind] ? t(JOB_KINDS[job.kind]) : job.kind}
                  </span>
                  <span className="block truncate text-xs text-foreground-muted">
                    {[job.item, job.workspace, job.person].filter(Boolean).join(" · ") || "—"}
                  </span>
                  <span
                    dir="auto"
                    className="mt-1 block text-xs break-words text-foreground-secondary md:hidden"
                  >
                    {job.error}
                  </span>
                </TableCell>
                <TableCell className="hidden py-3 align-top md:table-cell">
                  <span dir="auto" className="block text-xs break-words text-foreground-secondary">
                    {job.error ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="py-3 align-top text-sm">
                  <span className={cn("block", job.failedAt && "text-destructive")}>
                    {job.failedAt
                      ? t("platform.google.stopped", { count: job.attempts })
                      : t("platform.google.willRetry", { count: job.attempts })}
                  </span>
                  <span className="block text-xs text-foreground-muted">
                    {formatDateTime(job.failedAt ?? job.nextAttemptAt)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function People({ health }: { health: GoogleSyncHealth }): React.ReactElement {
  const { t, formatDateTime } = useLocale()
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-xl">{t("platform.google.peopleTitle")}</h2>
        <p className="text-xs text-foreground-muted">{t("platform.google.peopleHint")}</p>
      </div>
      {health.people.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-foreground-muted">
          {t("platform.google.noPeople")}
        </p>
      ) : (
        <ul className="border-t">
          {health.people.map((person) => (
            <li key={person.userId} className="flex flex-wrap items-baseline gap-x-3 border-b py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{person.name}</span>
                <span className="block truncate text-xs text-foreground-muted" dir="ltr">
                  {person.email}
                </span>
              </span>
              <span className="text-xs text-foreground-muted">
                {person.state === "revoked"
                  ? t("platform.google.revoked")
                  : t("platform.google.error")}
                {" · "}
                {formatDateTime(person.since)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
