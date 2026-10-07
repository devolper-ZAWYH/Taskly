"use client"

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
import { toastManager } from "@/components/ui/toast"
import { EMPTY_TASK, TaskFields } from "@/features/tasks/components/task-fields"
import { useCreateTask } from "@/features/tasks/hooks/use-tasks"
import { formatTaskRef } from "@/features/tasks/lib/task-meta"
import type { TaskInput } from "@/lib/api/tasks"
import { useLocale } from "@/lib/i18n/locale-provider"

export function TaskCreateDialog({
  open,
  onOpenChange,
  initial,
  showRelated = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefilled values (e.g. assignees, due date, meetingId). */
  initial?: Partial<TaskInput>
  /** Offer the "Related to" picker (task page); inside a meeting the link is implied. */
  showRelated?: boolean
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        {/* Mounted only while open so every opening starts from a blank draft. */}
        {open ? (
          <TaskCreateForm
            initial={initial}
            showRelated={showRelated}
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
  onDone,
}: {
  initial?: Partial<TaskInput>
  showRelated: boolean
  onDone: () => void
}): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const createTask = useCreateTask()
  const [draft, setDraft] = React.useState<TaskInput>({ ...EMPTY_TASK, ...initial })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    createTask.mutate(draft, {
      onSuccess: (task) => {
        toastManager.add({
          type: "success",
          title: t("tasks.create.created", { ref: formatTaskRef(task.number) }),
        })
        onDone()
      },
    })
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle className="font-display text-xl">{t("tasks.create.title")}</DialogTitle>
        <DialogDescription>{t("tasks.create.description")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <TaskFields value={draft} onChange={setDraft} showRelated={showRelated} autoFocusTitle />
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
