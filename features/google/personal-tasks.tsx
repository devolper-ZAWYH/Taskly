"use client"

import { CircleCheckIcon, CircleIcon, ExternalLinkIcon, LockIcon, Trash2Icon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError, FormRow } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { toastManager } from "@/components/ui/toast"
import { toDateKey } from "@/features/calendar/lib/calendar-utils"
import {
  useCreatePersonalTask,
  useDeletePersonalTask,
  usePersonalTasks,
  useUpdatePersonalTask,
} from "@/features/google/hooks"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { PersonalTask } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Overdue by the viewer's own calendar day (Google Tasks keeps dates only). */
export function isPersonalOverdue(task: PersonalTask, todayKey: string): boolean {
  return !task.completed && Boolean(task.dueDate) && task.dueDate < todayKey
}

/** Open first, then by due date (undated last); Google's own order otherwise. */
function byDue(a: PersonalTask, b: PersonalTask): number {
  return (
    Number(a.completed) - Number(b.completed) ||
    (a.dueDate || "9999").localeCompare(b.dueDate || "9999")
  )
}

/** Round tick for a personal task; toggles `completed` straight away. */
export function PersonalTaskCheck({ task }: { task: PersonalTask }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const update = useUpdatePersonalTask()
  const title = task.title || t("google.noTitle")
  const Icon = task.completed ? CircleCheckIcon : CircleIcon
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={task.completed}
      aria-label={
        task.completed
          ? t("google.tasks.markOpen", { title })
          : t("google.tasks.markDone", { title })
      }
      onClick={(e) => {
        e.stopPropagation()
        update.mutate(
          { task, patch: { completed: !task.completed } },
          { onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }) },
        )
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "grid size-7 shrink-0 cursor-pointer place-items-center rounded-full transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        task.completed ? "text-success" : "text-foreground-muted hover:text-foreground",
      )}
    >
      <Icon className="size-4.5" aria-hidden="true" />
    </button>
  )
}

/** The Personal tab: the person's selected Google Tasks. */
export function PersonalTaskList({
  showCompleted,
  onOpen,
}: {
  showCompleted: boolean
  onOpen: (task: PersonalTask) => void
}): React.ReactElement {
  const { t, errorMessage, formatDate } = useLocale()
  const tasks = usePersonalTasks(showCompleted, true)
  const todayKey = toDateKey(new Date())
  const rows = [...(tasks.data ?? [])].sort(byDue)

  return (
    <Table className="table-fixed" data-testid="personal-tasks">
      <TableHeader>
        <TableRow className="border-b border-border hover:bg-transparent">
          <TableHead className="w-11">
            <span className="sr-only">{t("google.tasks.columns.done")}</span>
          </TableHead>
          <TableHead className="eyebrow">{t("google.tasks.columns.title")}</TableHead>
          <TableHead className="eyebrow hidden w-44 sm:table-cell">
            {t("google.tasks.columns.list")}
          </TableHead>
          <TableHead className="eyebrow hidden w-36 sm:table-cell">
            {t("google.tasks.columns.due")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.isPending
          ? Array.from({ length: 4 }, (_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 4 }, (__, j) => (
                  <TableCell key={j} className="h-13">
                    <Skeleton className="h-4 w-full max-w-40" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : null}
        {!tasks.isPending && rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={4} className="h-40 text-center text-sm text-foreground-muted">
              {tasks.isError
                ? errorMessage(tasks.error)
                : showCompleted
                  ? t("google.tasks.emptyAll")
                  : t("google.tasks.empty")}
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((task) => {
          const overdue = isPersonalOverdue(task, todayKey)
          const due = task.dueDate ? (
            <span className={overdue ? "font-semibold text-destructive-foreground" : undefined}>
              {formatDate(task.dueDate)}
              {overdue ? (
                <span className="sr-only"> · {t("google.tasks.overdue")}</span>
              ) : null}
            </span>
          ) : null
          return (
            <TableRow
              key={task.id}
              tabIndex={0}
              onClick={() => onOpen(task)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onOpen(task)
              }}
              className="cursor-pointer outline-none hover:bg-surface-muted focus-visible:bg-surface-muted"
              data-testid="personal-task"
            >
              <TableCell className="h-13 ps-1">
                <PersonalTaskCheck task={task} />
              </TableCell>
              <TableCell className="max-w-0">
                {/* Inline dir="auto": the title reads in its own direction but stays at the row's start. */}
                <span
                  className={cn(
                    "block truncate font-medium",
                    task.completed && "text-foreground-muted line-through",
                  )}
                >
                  <span dir="auto">{task.title || t("google.noTitle")}</span>
                </span>
                {/* Mobile: list and due date move under the title. */}
                <span className="mt-0.5 flex min-w-0 gap-1.5 text-xs text-foreground-muted sm:hidden">
                  <span dir="auto" className="truncate">
                    {task.tasklistTitle}
                  </span>
                  {due ? <span className="shrink-0">· {due}</span> : null}
                </span>
              </TableCell>
              <TableCell className="hidden text-sm text-foreground-secondary sm:table-cell">
                <span dir="auto" className="block truncate">
                  {task.tasklistTitle}
                </span>
              </TableCell>
              <TableCell className="hidden text-sm text-foreground-secondary tabular-nums sm:table-cell">
                {due ?? "—"}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export type PersonalTaskDialogState = { mode: "create" } | { mode: "edit"; task: PersonalTask }

/** Create a personal task (in the default list) or edit one: title, notes, due date. */
export function PersonalTaskDialog({
  state,
  onClose,
}: {
  state: PersonalTaskDialogState | null
  onClose: () => void
}): React.ReactElement {
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-lg">
        {/* Mounted only while open so each opening starts from its own values. */}
        {state ? <PersonalTaskForm state={state} onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  )
}

function PersonalTaskForm({
  state,
  onClose,
}: {
  state: PersonalTaskDialogState
  onClose: () => void
}): React.ReactElement {
  const { t, errorMessage, formatDate, formatDateTime } = useLocale()
  const editing = state.mode === "edit" ? state.task : null
  const createTask = useCreatePersonalTask()
  const updateTask = useUpdatePersonalTask()
  const deleteTask = useDeletePersonalTask()
  const mutation = editing ? updateTask : createTask
  const [title, setTitle] = React.useState(editing?.title ?? "")
  const [notes, setNotes] = React.useState(editing?.notes ?? "")
  const [dueDate, setDueDate] = React.useState(editing?.dueDate ?? "")
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const dirty =
    !editing || title !== editing.title || notes !== editing.notes || dueDate !== editing.dueDate

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const done = (key: "created" | "saved") => () => {
      toastManager.add({ type: "success", title: t(`google.tasks.form.${key}`) })
      onClose()
    }
    if (editing) {
      updateTask.mutate(
        { task: editing, patch: { title, notes, dueDate } },
        { onSuccess: done("saved") },
      )
    } else {
      createTask.mutate({ title, notes, dueDate, completed: false }, { onSuccess: done("created") })
    }
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle className="font-display text-xl">
          {editing ? t("google.tasks.form.editTitle") : t("google.tasks.form.createTitle")}
        </DialogTitle>
        <DialogDescription>
          {editing ? (
            <>
              <span dir="auto">{t("google.tasks.form.inList", { list: editing.tasklistTitle })}</span>
              {editing.completedAt
                ? " · " +
                  t("google.tasks.form.completedAt", { date: formatDateTime(editing.completedAt) })
                : ""}
            </>
          ) : (
            t("google.tasks.form.createDescription")
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <FormRow label={t("google.tasks.form.title")} htmlFor="personal-task-title">
            <Input
              id="personal-task-title"
              autoFocus
              dir="auto"
              value={title}
              placeholder={t("google.tasks.form.titlePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </FormRow>
          <FormRow label={t("google.tasks.form.notes")} htmlFor="personal-task-notes">
            <Textarea
              id="personal-task-notes"
              dir="auto"
              rows={4}
              value={notes}
              placeholder={t("google.tasks.form.notesPlaceholder")}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormRow>
          <FormRow label={t("google.tasks.form.due")} hint={t("google.tasks.form.dueHint")}>
            <DatePicker
              value={dueDate}
              onChange={setDueDate}
              placeholder={t("common.pickDate")}
              clearLabel={t("common.clear")}
              formatValue={(ymd) => formatDate(ymd)}
            />
          </FormRow>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-xs text-foreground-muted">
              <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {t("google.tasks.private")}
            </p>
            {editing?.webLink ? (
              <a
                href={editing.webLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-ink hover:underline"
              >
                {t("google.tasks.form.openInGoogle")}
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </div>
          <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
        </div>
      </DialogPanel>
      <DialogFooter className="sm:[&>*]:flex-none">
        {editing ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive-foreground sm:me-auto"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2Icon />
            {t("google.tasks.delete")}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={!title.trim() || !dirty}
        >
          {editing ? t("common.save") : t("google.tasks.form.submit")}
        </Button>
      </DialogFooter>

      {editing ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("google.tasks.deleteTitle")}
          description={t("google.tasks.deleteBody", {
            title: editing.title || t("google.noTitle"),
          })}
          confirmLabel={t("google.tasks.delete")}
          onConfirm={async () => {
            await deleteTask.mutateAsync(editing)
            toastManager.add({ type: "success", title: t("google.tasks.deleted") })
            onClose()
          }}
        />
      ) : null}
    </form>
  )
}
