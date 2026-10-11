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
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { TimePicker } from "@/components/ui/time-picker"
import { toastManager } from "@/components/ui/toast"
import {
  browserTimeZone,
  useCreatePersonalEvent,
  useGoogleContainers,
  useUpdatePersonalEvent,
} from "@/features/google/hooks"
import type { EventSpan } from "@/features/google/personal-events"
import { WhereSwitch } from "@/features/google/where-switch"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { GoogleContainer, PersonalEvent, PersonalEventInput } from "@/lib/types"

/** What the form edits: an event input without the zone (always the browser's). */
export type PersonalEventDraft = Omit<PersonalEventInput, "timeZone">

export type PersonalEventFormState =
  | { mode: "create"; initial: PersonalEventDraft }
  | { mode: "edit"; span: EventSpan }

/** A single-day event as the form shows it (multi-day events are edited in Google). */
function toDraft(span: EventSpan): PersonalEventDraft {
  const { title, description, location, allDay } = span.event
  return {
    title,
    description,
    location,
    date: span.startKey,
    startTime: span.startTime || "09:00",
    endTime: span.endTime || "10:00",
    allDay,
  }
}

export function PersonalEventFormDialog({
  state,
  onClose,
  onSaved,
}: {
  state: PersonalEventFormState | null
  onClose: () => void
  onSaved: (event: PersonalEvent) => void
}): React.ReactElement {
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-xl">
        {/* Mounted only while open so each opening starts from its own values. */}
        {state ? <PersonalEventForm state={state} onClose={onClose} onSaved={onSaved} /> : null}
      </DialogPopup>
    </Dialog>
  )
}

/**
 * Create or edit an event on the person's own Google Calendar. Inside the
 * new-meeting dialog it also shows the "Where" choice (`switchTo`).
 */
export function PersonalEventForm({
  state,
  onClose,
  onSaved,
  switchTo,
}: {
  state: PersonalEventFormState
  onClose: () => void
  onSaved: (event: PersonalEvent) => void
  /** Offer "Where": the workspace's name, and how to hand the draft back to the meeting form. */
  switchTo?: { workspaceName: string; onWorkspace: (draft: PersonalEventDraft) => void }
}): React.ReactElement {
  const { t, errorMessage, formatDate } = useLocale()
  const creating = state.mode === "create"
  const createEvent = useCreatePersonalEvent()
  const updateEvent = useUpdatePersonalEvent()
  const mutation = creating ? createEvent : updateEvent
  const [draft, setDraft] = React.useState<PersonalEventDraft>(() =>
    state.mode === "create" ? state.initial : toDraft(state.span),
  )
  const [calendarId, setCalendarId] = React.useState<string | null>(null)
  const [timeError, setTimeError] = React.useState(false)
  const set = <K extends keyof PersonalEventDraft>(key: K, value: PersonalEventDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const badRange = !draft.allDay && draft.endTime <= draft.startTime
    setTimeError(badRange)
    if (badRange) return
    const input: PersonalEventInput = { ...draft, timeZone: browserTimeZone() }
    const done = (saved: PersonalEvent) => {
      toastManager.add({
        type: "success",
        title: creating ? t("google.calendar.form.created") : t("google.calendar.form.saved"),
      })
      onSaved(saved)
    }
    if (state.mode === "create") createEvent.mutate({ calendarId, input }, { onSuccess: done })
    else {
      const { calendarId: cal, id } = state.span.event
      updateEvent.mutate({ calendarId: cal, id, input }, { onSuccess: done })
    }
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle className="font-display text-xl">
          {creating ? t("google.calendar.form.createTitle") : t("google.calendar.form.editTitle")}
        </DialogTitle>
        <DialogDescription>
          {creating
            ? t("google.calendar.form.createDescription")
            : state.span.event.recurring
              ? t("google.calendar.panel.occurrenceOnly")
              : t("google.calendar.form.editDescription")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          {switchTo ? (
            <WhereSwitch
              value="personal"
              workspaceName={switchTo.workspaceName}
              onChange={() => switchTo.onWorkspace(draft)}
            />
          ) : null}

          <FormRow label={t("google.calendar.form.title")} htmlFor="event-title">
            <Input
              id="event-title"
              autoFocus
              dir="auto"
              value={draft.title}
              placeholder={t("google.calendar.form.titlePlaceholder")}
              onChange={(e) => set("title", e.target.value)}
            />
          </FormRow>

          <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
            <FormRow label={t("google.calendar.form.date")}>
              <DatePicker
                value={draft.date}
                onChange={(v) => v && set("date", v)}
                placeholder={t("common.pickDate")}
                clearLabel={t("common.clear")}
                formatValue={(ymd) => formatDate(ymd)}
              />
            </FormRow>
            <label className="flex h-8 cursor-pointer items-center gap-2 self-end text-sm text-foreground-secondary">
              <Switch
                checked={draft.allDay}
                onCheckedChange={(allDay) => {
                  set("allDay", allDay)
                  setTimeError(false)
                }}
              />
              {t("google.calendar.form.allDay")}
            </label>
          </div>

          {draft.allDay ? null : (
            <div className="grid grid-cols-2 gap-5 sm:flex">
              <FormRow label={t("google.calendar.form.start")}>
                <TimePicker
                  className="shrink-0"
                  value={draft.startTime}
                  aria-label={t("google.calendar.form.start")}
                  minuteStep={15}
                  onChange={(v) => set("startTime", v)}
                />
              </FormRow>
              <FormRow label={t("google.calendar.form.end")}>
                <TimePicker
                  className="shrink-0"
                  value={draft.endTime}
                  aria-label={t("google.calendar.form.end")}
                  minuteStep={15}
                  onChange={(v) => set("endTime", v)}
                />
              </FormRow>
            </div>
          )}

          <FormRow label={t("google.calendar.form.location")} htmlFor="event-location">
            <Input
              id="event-location"
              dir="auto"
              value={draft.location}
              placeholder={t("google.calendar.form.locationPlaceholder")}
              onChange={(e) => set("location", e.target.value)}
            />
          </FormRow>

          <FormRow label={t("google.calendar.form.description")} htmlFor="event-description">
            <Textarea
              id="event-description"
              dir="auto"
              rows={3}
              value={draft.description}
              placeholder={t("google.calendar.form.descriptionPlaceholder")}
              onChange={(e) => set("description", e.target.value)}
            />
          </FormRow>

          {creating ? <CalendarPicker value={calendarId} onChange={setCalendarId} /> : null}

          <FormError
            message={
              timeError
                ? t("google.calendar.form.endBeforeStart")
                : mutation.error
                  ? errorMessage(mutation.error)
                  : null
            }
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={mutation.isPending} disabled={!draft.title.trim()}>
          {creating ? t("google.calendar.form.submit") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Which of the person's shown calendars gets the new event; their main one by default. */
function CalendarPicker({
  value,
  onChange,
}: {
  value: string | null
  onChange: (calendarId: string) => void
}): React.ReactElement | null {
  const { t } = useLocale()
  const containers = useGoogleContainers({ refresh: false, enabled: true })
  const calendars = (containers.data ?? []).filter(
    (c) => c.kind === "calendar" && c.accountId === null && c.selected,
  )
  // Until they pick one, the event goes to the main calendar (null on the wire).
  const current = calendars.find((c) => c.id === value) ?? calendars.find((c) => c.primary)
  if (calendars.length === 0) return null

  return (
    <FormRow label={t("google.calendar.form.calendar")}>
      <Select value={current?.id ?? null} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger data-testid="event-calendar">
          {current ? <CalendarOption calendar={current} /> : null}
        </SelectTrigger>
        <SelectContent>
          {calendars.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              <CalendarOption calendar={c} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormRow>
  )
}

function CalendarOption({ calendar }: { calendar: GoogleContainer }): React.ReactElement {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: calendar.color ?? "var(--foreground-muted)" }}
      />
      <span dir="auto" className="truncate">
        {calendar.title}
      </span>
    </span>
  )
}
