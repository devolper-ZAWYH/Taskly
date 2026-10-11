"use client"

import { LockIcon } from "lucide-react"
import * as React from "react"
import { FormError } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import { useGoogleConnected } from "@/features/google/hooks"
import { EMPTY_TASK, TaskFields } from "@/features/tasks/components/task-fields"
import { useCreateTask } from "@/features/tasks/hooks/use-tasks"
import { useViewer } from "@/features/workspace/workspace-context"
import { canCreateSharedTask, type TaskInput } from "@/lib/api/tasks"
import { useLocale } from "@/lib/i18n/locale-provider"

export function TaskCreateDialog({
  open,
  onOpenChange,
  initial,
  showRelated = false,
  privateChoice = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefilled values (e.g. assignees, due date, meetingId, private). */
  initial?: Partial<TaskInput>
  /** Offer the "Related to" picker (task page); inside a meeting the link is implied. */
  showRelated?: boolean
  /** Administrators may switch between a private task and a workspace task. */
  privateChoice?: boolean
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        {/* Mounted only while open so every opening starts from a blank draft. */}
        {open ? (
          <TaskCreateForm
            initial={initial}
            showRelated={showRelated}
            privateChoice={privateChoice}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  )
}

function TaskCreateForm({
  initial,
  showRelated,
  privateChoice,
  onDone,
}: {
  initial?: Partial<TaskInput>
  showRelated: boolean
  privateChoice: boolean
  onDone: () => void
}): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const createTask = useCreateTask()
  const viewer = useViewer()
  const googleConnected = useGoogleConnected()
  // Members can only create tasks for themselves.
  const canShare = canCreateSharedTask(viewer)
  const [draft, setDraft] = React.useState<TaskInput>({
    ...EMPTY_TASK,
    googleSync: googleConnected,
    ...initial,
    private: canShare ? initial?.private === true : true,
  })
  const isPrivate = draft.private === true

  function submit(event: React.FormEvent) {
    event.preventDefault()
    // A private task is yours alone; Google sync only applies to those.
    const input: TaskInput = isPrivate
      ? { ...draft, assigneeIds: [] }
      : { ...draft, googleSync: false }
    createTask.mutate(input, {
      onSuccess: () => {
        toastManager.add({
          type: "success",
          title: t("tasks.create.created"),
        })
        onDone()
      },
    })
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle className="font-display text-xl">{t("tasks.create.title")}</DialogTitle>
        <DialogDescription>
          {isPrivate ? t("tasks.create.descriptionPrivate") : t("tasks.create.description")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          {canShare && privateChoice ? (
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-md border p-3">
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <LockIcon className="size-3.5" aria-hidden="true" />
                  {t("tasks.create.private")}
                </span>
                <span className="mt-0.5 block text-xs text-foreground-muted">
                  {t("tasks.create.privateHint")}
                </span>
              </span>
              <Switch
                checked={isPrivate}
                onCheckedChange={(on) => setDraft({ ...draft, private: on })}
                data-testid="task-private"
              />
            </label>
          ) : null}
          <TaskFields
            value={draft}
            onChange={setDraft}
            showRelated={showRelated}
            privateTask={isPrivate}
            autoFocusTitle
          />
          <FormError message={createTask.error ? errorMessage(createTask.error) : null} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={createTask.isPending} disabled={!draft.title.trim()}>
          {t("tasks.create.submit")}
        </Button>
      </DialogFooter>
    </form>
  )
}
