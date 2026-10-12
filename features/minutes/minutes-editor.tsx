"use client"

import { LockIcon, Trash2Icon, UserRoundPlusIcon, UsersIcon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError, FormRow } from "@/components/shell/form-row"
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
import { Textarea } from "@/components/ui/textarea"
import { toastManager } from "@/components/ui/toast"
import { useDeleteMinutes, useSaveMinutes } from "@/features/minutes/hooks"
import { AssigneePicker } from "@/features/tasks/components/assignees"
import { useViewer, useWorkspace } from "@/features/workspace/workspace-context"
import type { MinutesInput } from "@/lib/api/minutes"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, MeetingMinutes, MinutesVisibility } from "@/lib/types"
import { cn } from "@/lib/utils"

export type MinutesEditorState =
  | { mode: "create"; meeting: Pick<Meeting, "id" | "title" | "date"> }
  | { mode: "edit"; minutes: MeetingMinutes }

export const VISIBILITY_ICONS: Record<MinutesVisibility, typeof LockIcon> = {
  private: LockIcon,
  workspace: UsersIcon,
  people: UserRoundPlusIcon,
}

/** Write or edit your own minutes of a meeting, and choose who can read them. */
export function MinutesEditorDialog({
  state,
  onClose,
}: {
  state: MinutesEditorState | null
  onClose: () => void
}): React.ReactElement {
  const [dirty, setDirty] = React.useState(false)
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)

  function requestClose() {
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  return (
    <>
      <Dialog open={Boolean(state)} onOpenChange={(open) => !open && requestClose()}>
        <DialogPopup className="sm:max-w-2xl">
          {/* Mounted only while open so each opening starts from its own values. */}
          {state ? (
            <MinutesForm
              state={state}
              onDirtyChange={setDirty}
              onCancel={requestClose}
              onDone={() => {
                setDirty(false)
                onClose()
              }}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
      <DiscardDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        onDiscard={() => {
          setDirty(false)
          onClose()
        }}
      />
    </>
  )
}

function DiscardDialog({
  open,
  onOpenChange,
  onDiscard,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDiscard: () => void
}): React.ReactElement {
  const { t } = useLocale()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("minutes.editor.discardTitle")}
      description={t("minutes.editor.discardBody")}
      confirmLabel={t("minutes.editor.discard")}
      onConfirm={async () => onDiscard()}
    />
  )
}

function MinutesForm({
  state,
  onDirtyChange,
  onCancel,
  onDone,
}: {
  state: MinutesEditorState
  onDirtyChange: (dirty: boolean) => void
  onCancel: () => void
  onDone: () => void
}): React.ReactElement {
  const { t, errorMessage, formatDate } = useLocale()
  const { account } = useWorkspace()
  const me = useViewer()
  const save = useSaveMinutes()
  const remove = useDeleteMinutes()
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const initial: MinutesInput =
    state.mode === "edit"
      ? {
          body: state.minutes.body,
          visibility: state.minutes.visibility,
          sharedWithIds: state.minutes.sharedWithIds,
        }
      : { body: "", visibility: "private", sharedWithIds: [] }
  const [draft, setDraft] = React.useState<MinutesInput>(initial)
  const meeting =
    state.mode === "edit"
      ? { title: state.minutes.meetingTitle, date: state.minutes.meetingDate }
      : state.meeting

  const dirty =
    draft.body !== initial.body ||
    draft.visibility !== initial.visibility ||
    draft.sharedWithIds.join() !== initial.sharedWithIds.join()
  React.useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const set = <K extends keyof MinutesInput>(key: K, value: MinutesInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const canSave =
    Boolean(draft.body.trim()) &&
    (draft.visibility !== "people" || draft.sharedWithIds.length > 0)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const input: MinutesInput = {
      ...draft,
      sharedWithIds: draft.visibility === "people" ? draft.sharedWithIds : [],
    }
    save.mutate(
      state.mode === "create"
        ? { mode: "create", meetingId: state.meeting.id, input }
        : {
            mode: "edit",
            id: state.minutes.id,
            input,
            expectedUpdatedAt: state.minutes.updatedAt,
          },
      {
        onSuccess: () => {
          toastManager.add({ type: "success", title: t("minutes.editor.saved") })
          onDone()
        },
      },
    )
  }

  const options: { value: MinutesVisibility; label: string }[] = [
    { value: "private", label: t("minutes.visibility.private") },
    { value: "workspace", label: t("minutes.visibility.workspace", { workspace: account.name }) },
    { value: "people", label: t("minutes.visibility.people") },
  ]

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle className="font-display text-xl">
          {state.mode === "create" ? t("minutes.editor.createTitle") : t("minutes.editor.editTitle")}
        </DialogTitle>
        <DialogDescription>
          <span dir="auto">{meeting.title}</span> · {formatDate(meeting.date)}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <FormRow label={t("minutes.editor.body")} htmlFor="minutes-body">
            <Textarea
              id="minutes-body"
              autoFocus
              dir="auto"
              rows={14}
              className="[&_textarea]:max-h-[50vh] [&_textarea]:min-h-64 [&_textarea]:text-start [&_textarea]:[unicode-bidi:plaintext]"
              value={draft.body}
              placeholder={t("minutes.editor.bodyPlaceholder")}
              onChange={(e) => set("body", e.target.value)}
            />
          </FormRow>

          <FormRow
            label={t("minutes.editor.whoCanRead")}
            hint={t(`minutes.visibilityHint.${draft.visibility}`)}
          >
            <div
              className="flex max-w-full flex-wrap self-start rounded-md border p-0.5"
              role="radiogroup"
              aria-label={t("minutes.editor.whoCanRead")}
              data-testid="minutes-visibility"
            >
              {options.map((option) => {
                const Icon = VISIBILITY_ICONS[option.value]
                const selected = draft.visibility === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => set("visibility", option.value)}
                    className={cn(
                      "inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-[6px] px-3 text-sm transition-colors",
                      selected
                        ? "bg-foreground text-background"
                        : "text-foreground-secondary hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate" dir="auto">
                      {option.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </FormRow>

          {draft.visibility === "people" ? (
            <FormRow label={t("minutes.editor.sharedWith")}>
              <AssigneePicker
                value={draft.sharedWithIds}
                onChange={(ids) => set("sharedWithIds", ids)}
                addLabel={t("minutes.editor.addPeople")}
                exclude={[me.id]}
              />
            </FormRow>
          ) : null}

          <FormError message={save.error ? errorMessage(save.error) : null} />
        </div>
      </DialogPanel>
      <DialogFooter className="flex-wrap justify-between gap-2">
        <div>
          {state.mode === "edit" ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive-foreground"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon />
              {t("common.delete")}
            </Button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!canSave}>
            {t("minutes.editor.save")}
          </Button>
        </div>
      </DialogFooter>

      {state.mode === "edit" ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("minutes.editor.deleteTitle")}
          description={t("minutes.editor.deleteBody")}
          confirmLabel={t("common.delete")}
          onConfirm={async () => {
            await remove.mutateAsync(state.minutes.id)
            toastManager.add({ type: "success", title: t("minutes.editor.deleted") })
            onDone()
          }}
        />
      ) : null}
    </form>
  )
}
