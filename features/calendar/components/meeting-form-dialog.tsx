"use client"

import * as React from "react"
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
import { Textarea } from "@/components/ui/textarea"
import { TimePicker } from "@/components/ui/time-picker"
import { toastManager } from "@/components/ui/toast"
import { useCreateMeeting, useUpdateMeeting } from "@/features/calendar/hooks/use-meetings"
import { AssigneePicker } from "@/features/tasks/components/assignees"
import type { MeetingInput } from "@/lib/api/meetings"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting } from "@/lib/types"

export type MeetingFormState =
  { mode: "create"; initial: MeetingInput } | { mode: "edit"; meeting: Meeting }

export function toMeetingInput(meeting: Meeting): MeetingInput {
  const { title, notes, date, startTime, endTime, location, attendeeIds } = meeting
  return { title, notes, date, startTime, endTime, location, attendeeIds }
}

export function MeetingFormDialog({
  state,
  onClose,
  onSaved,
}: {
  state: MeetingFormState | null
  onClose: () => void
  onSaved: (meeting: Meeting) => void
}): React.ReactElement {
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-xl">
        {/* Mounted only while open so each opening starts from its own values. */}
        {state ? <MeetingForm state={state} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogPopup>
    </Dialog>
  )
}

function MeetingForm({
  state,
  onClose,
  onSaved,
}: {
  state: MeetingFormState
  onClose: () => void
  onSaved: (meeting: Meeting) => void
}): React.ReactElement {
  const { t, errorMessage, formatDate } = useLocale()
  const createMeeting = useCreateMeeting()
  const updateMeeting = useUpdateMeeting()
  const [draft, setDraft] = React.useState<MeetingInput>(
    state.mode === "create" ? state.initial : toMeetingInput(state.meeting),
  )
  const mutation = state.mode === "create" ? createMeeting : updateMeeting
  const set = <K extends keyof MeetingInput>(key: K, value: MeetingInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const done = (meeting: Meeting) => {
      toastManager.add({
        type: "success",
        title: state.mode === "create" ? t("meetings.create.created") : t("meetings.edit.saved"),
      })
      onSaved(meeting)
    }
    if (state.mode === "create") createMeeting.mutate(draft, { onSuccess: done })
    else updateMeeting.mutate({ id: state.meeting.id, input: draft }, { onSuccess: done })
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle className="font-display text-xl">
          {state.mode === "create" ? t("meetings.create.title") : t("meetings.edit.title")}
        </DialogTitle>
        {state.mode === "create" ? (
          <DialogDescription>{t("meetings.create.description")}</DialogDescription>
        ) : null}
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <FormRow label={t("meetings.form.title")} htmlFor="meeting-title">
            <Input
              id="meeting-title"
              autoFocus
              value={draft.title}
              placeholder={t("meetings.form.titlePlaceholder")}
              onChange={(e) => set("title", e.target.value)}
            />
          </FormRow>

          <div className="grid gap-5 sm:grid-cols-[1fr_auto_auto]">
            <FormRow label={t("meetings.form.date")}>
              <DatePicker
                value={draft.date}
                onChange={(v) => set("date", v)}
                placeholder={t("common.pickDate")}
                clearLabel={t("common.clear")}
                formatValue={(ymd) => formatDate(ymd)}
              />
            </FormRow>
            <FormRow label={t("meetings.form.start")}>
              <TimePicker
                className="shrink-0"
                value={draft.startTime}
                aria-label={t("meetings.form.start")}
                minuteStep={15}
                onChange={(v) => set("startTime", v)}
              />
            </FormRow>
            <FormRow label={t("meetings.form.end")}>
              <TimePicker
                className="shrink-0"
                value={draft.endTime}
                aria-label={t("meetings.form.end")}
                minuteStep={15}
                onChange={(v) => set("endTime", v)}
              />
            </FormRow>
          </div>

          <FormRow label={t("meetings.form.location")} htmlFor="meeting-location">
            <Input
              id="meeting-location"
              value={draft.location}
              placeholder={t("meetings.form.locationPlaceholder")}
              onChange={(e) => set("location", e.target.value)}
            />
          </FormRow>

          <FormRow label={t("meetings.form.attendees")}>
            <AssigneePicker
              value={draft.attendeeIds}
              onChange={(ids) => set("attendeeIds", ids)}
              addLabel={t("meetings.form.addAttendee")}
            />
          </FormRow>

          <FormRow label={t("meetings.form.notes")} htmlFor="meeting-notes">
            <Textarea
              id="meeting-notes"
              rows={4}
              value={draft.notes}
              placeholder={t("meetings.form.notesPlaceholder")}
              onChange={(e) => set("notes", e.target.value)}
            />
          </FormRow>

          <FormError message={mutation.error ? errorMessage(mutation.error) : null} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={mutation.isPending} disabled={!draft.title.trim()}>
          {state.mode === "create" ? t("meetings.create.submit") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  )
}
