"use client"

import { BanIcon, CalendarDaysIcon, Loader2Icon, LockIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet"
import { toastManager } from "@/components/ui/toast"
import { useMeeting } from "@/features/calendar/hooks/use-meetings"
import { SyncedToGoogle } from "@/features/google/synced-marker"
import { useViewer, useWorkspacePath } from "@/features/workspace/workspace-context"
import { StatusBadge } from "@/features/tasks/components/task-badges"
import { TaskFields } from "@/features/tasks/components/task-fields"
import {
  useCancelTask,
  useDeleteTask,
  usePeople,
  useTask,
  useUpdateTask,
} from "@/features/tasks/hooks/use-tasks"
import { isOverdue } from "@/features/tasks/lib/task-meta"
import { canDeleteTask, canEditTask, isClosed, type TaskInput } from "@/lib/api/tasks"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Task } from "@/lib/types"

function toInput(task: Task): TaskInput {
  const {
    title,
    description,
    status,
    priority,
    startDate,
    startTime,
    dueDate,
    dueTime,
    assigneeIds,
    meetingId,
  } = task
  return {
    title,
    description,
    status,
    priority,
    startDate,
    startTime,
    dueDate,
    dueTime,
    assigneeIds,
    meetingId,
    // Only private tasks have their own Google sync switch.
    ...(task.private ? { googleSync: task.googleSync } : {}),
  }
}

/** Side panel for viewing and editing one task, driven by `?task=<id>`. */
export function TaskPanel({
  taskId,
  onClose,
}: {
  taskId: string | null
  onClose: () => void
}): React.ReactElement {
  const { t } = useLocale()
  const query = useTask(taskId)

  return (
    <Sheet open={Boolean(taskId)} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup className="max-w-xl">
        {query.data ? (
          <TaskEditor key={query.data.id} task={query.data} onClose={onClose} />
        ) : query.isError ? (
          <SheetHeader>
            <SheetTitle className="font-display text-xl">{t("tasks.panel.notFoundTitle")}</SheetTitle>
            <SheetDescription>{t("tasks.panel.notFound")}</SheetDescription>
          </SheetHeader>
        ) : (
          <div className="grid flex-1 place-items-center p-12">
            <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
          </div>
        )}
      </SheetPopup>
    </Sheet>
  )
}

function TaskEditor({ task, onClose }: { task: Task; onClose: () => void }): React.ReactElement {
  const { t, errorMessage, formatDateTime } = useLocale()
  const me = useViewer()
  const { data: people } = usePeople()
  const updateTask = useUpdateTask()
  const cancelTask = useCancelTask()
  const deleteTask = useDeleteTask()
  const [draft, setDraft] = React.useState<TaskInput>(() => toInput(task))
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  const statusOnly = !canEditTask(me, task)
  const dirty = JSON.stringify(draft) !== JSON.stringify(toInput(task))
  const creator = people?.find((p) => p.id === task.createdById)
  const error = updateTask.error ?? cancelTask.error

  function save(event: React.FormEvent) {
    event.preventDefault()
    updateTask.mutate(
      // Members may only move the status; send nothing else.
      { id: task.id, patch: statusOnly ? { status: draft.status } : draft },
      { onSuccess: () => toastManager.add({ type: "success", title: t("tasks.panel.saved") }) },
    )
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2 pe-8">
          <StatusBadge status={task.status} />
          {task.private ? (
            <span
              className="inline-flex items-center gap-1 text-xs text-foreground-muted"
              data-testid="task-private-badge"
            >
              <LockIcon className="size-3" aria-hidden="true" />
              {t("tasks.privateBadge")}
            </span>
          ) : null}
          {isOverdue(task) ? (
            <span className="text-xs font-semibold tracking-wide text-destructive-foreground uppercase">
              {t("tasks.panel.overdue")}
            </span>
          ) : null}
        </div>
        <SheetTitle className="font-display mt-1 text-xl leading-snug">{task.title}</SheetTitle>
        <SheetDescription className="text-xs">
          {creator ? t("tasks.form.createdBy", { name: creator.name }) + " · " : ""}
          {t("tasks.form.createdAt", { date: formatDateTime(task.createdAt) })}
          {task.completedAt
            ? " · " + t("tasks.form.completedAt", { date: formatDateTime(task.completedAt) })
            : ""}
        </SheetDescription>
        {/* Admins see (and change) the meeting in the form's chip instead. */}
        {task.meetingId && statusOnly ? <MeetingOrigin meetingId={task.meetingId} /> : null}
        {/* Cancelled tasks are taken out of Google; private ones sync only if switched on. */}
        <SyncedToGoogle
          involved={
            task.assigneeIds.includes(me.id) &&
            task.status !== "cancelled" &&
            (!task.private || task.googleSync)
          }
        />
      </SheetHeader>

      <SheetPanel>
        <div className="flex flex-col gap-5">
          {statusOnly ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-foreground-secondary">
              {t("tasks.form.statusOnlyHint")}
            </p>
          ) : null}
          <TaskFields
            value={draft}
            onChange={setDraft}
            showStatus
            statusOnly={statusOnly}
            showRelated={!statusOnly}
            privateTask={task.private}
          />
          <FormError message={error ? errorMessage(error) : null} />
        </div>
      </SheetPanel>

      <SheetFooter className="flex-wrap justify-between gap-2">
        <>
          <div className="flex gap-1">
            {!statusOnly && !isClosed(task.status) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={cancelTask.isPending}
                onClick={() =>
                  cancelTask.mutate(task.id, {
                    onSuccess: () =>
                      toastManager.add({ type: "success", title: t("tasks.panel.cancelled") }),
                  })
                }
              >
                <BanIcon />
                {t("tasks.panel.cancelTask")}
              </Button>
            ) : null}
            {canDeleteTask(me, task) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive-foreground"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon />
                {t("tasks.panel.deleteTask")}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.close")}
            </Button>
            <Button type="submit" disabled={!dirty} loading={updateTask.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </>
      </SheetFooter>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("tasks.panel.deleteTitle")}
        description={t("tasks.panel.deleteBody", { title: task.title })}
        confirmLabel={t("tasks.panel.deleteTask")}
        onConfirm={async () => {
          await deleteTask.mutateAsync(task.id)
          toastManager.add({ type: "success", title: t("tasks.panel.deleted") })
          onClose()
        }}
      />
    </form>
  )
}

/** "From meeting: …" link for action items; hidden if the meeting isn't visible. */
function MeetingOrigin({ meetingId }: { meetingId: string }): React.ReactElement | null {
  const { t, formatDate } = useLocale()
  const { data: meeting } = useMeeting(meetingId)
  const wsPath = useWorkspacePath()
  if (!meeting) return null
  return (
    <Link
      href={wsPath(`/calendar?view=week&date=${meeting.date}&meeting=${meeting.id}`)}
      className="mt-2 inline-flex max-w-full items-center gap-2 self-start rounded-sm border px-2 py-1 text-xs transition-colors hover:border-foreground"
    >
      <CalendarDaysIcon className="size-3.5 shrink-0 text-foreground-muted" />
      <span className="shrink-0 text-foreground-muted">{t("tasks.form.fromMeeting")}:</span>
      <span className="truncate font-medium">{meeting.title}</span>
      <span className="shrink-0 text-foreground-muted">· {formatDate(meeting.date)}</span>
    </Link>
  )
}
