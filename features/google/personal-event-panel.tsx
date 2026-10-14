"use client"

import {
  ExternalLinkIcon,
  InfoIcon,
  LockIcon,
  MapPinIcon,
  PencilIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
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
import { parseDateKey } from "@/features/calendar/lib/calendar-utils"
import { GoogleMark } from "@/features/google/google-mark"
import { useDeletePersonalEvent } from "@/features/google/hooks"
import type { EventSpan } from "@/features/google/personal-events"
import { useLocale } from "@/lib/i18n/locale-provider"

/**
 * Taskly edits one day at a time (`PersonalEventInput` has a single date), so
 * events that cross midnight keep their dates and are changed in Google.
 */
export function editableInTaskly(span: EventSpan): boolean {
  return span.event.editable && span.startKey === span.endKey && span.endTime !== "24:00"
}

/** Side panel for one of the viewer's own Google events. */
export function PersonalEventPanel({
  span,
  open,
  onClose,
  onEdit,
  addToWorkspace,
}: {
  /** Kept after closing so the panel can animate out with its content. */
  span: EventSpan | null
  open: boolean
  onClose: () => void
  onEdit: (span: EventSpan) => void
  /** Turning the event into a workspace meeting: offered to administrators, mentioned to members. */
  addToWorkspace: AddToWorkspace
}): React.ReactElement {
  return (
    <Sheet open={open && Boolean(span)} onOpenChange={(next) => !next && onClose()}>
      <SheetPopup className="max-w-xl" data-testid="personal-event-panel">
        {span ? (
          <EventDetail
            key={span.event.id}
            span={span}
            onClose={onClose}
            onEdit={onEdit}
            addToWorkspace={addToWorkspace}
          />
        ) : null}
      </SheetPopup>
    </Sheet>
  )
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/** "Saturday, 11 October 2026 · 09:00–10:00", or a range for multi-day events. */
function useWhen(span: EventSpan): React.ReactNode {
  const { t, intl } = useLocale()
  const { event } = span
  const longDate = new Intl.DateTimeFormat(intl, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
  if (event.allDay) {
    const start = parseDateKey(span.startKey, new Date())
    const end = parseDateKey(span.endKey, start)
    const days =
      span.startKey === span.endKey
        ? longDate.format(start)
        : new Intl.DateTimeFormat(intl, { day: "numeric", month: "short", year: "numeric" })
            .formatRange(start, end)
    return `${days} · ${t("google.calendar.allDay")}`
  }
  if (span.startKey === span.endKey) {
    return (
      <>
        {longDate.format(parseDateKey(span.startKey, new Date()))} ·{" "}
        <span dir="ltr">
          {span.startTime}–{span.endTime}
        </span>
      </>
    )
  }
  return new Intl.DateTimeFormat(intl, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatRange(new Date(event.start), new Date(event.end))
}

export type AddToWorkspace =
  | { allowed: true; workspaceName: string; pending: boolean; onAdd: (span: EventSpan) => void }
  | { allowed: false; workspaceName: string }

function EventDetail({
  span,
  onClose,
  onEdit,
  addToWorkspace,
}: {
  span: EventSpan
  onClose: () => void
  onEdit: (span: EventSpan) => void
  addToWorkspace: AddToWorkspace
}): React.ReactElement {
  const { t } = useLocale()
  const { event } = span
  const deleteEvent = useDeletePersonalEvent()
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const when = useWhen(span)
  const canEdit = editableInTaskly(span)
  const title = event.title || t("google.noTitle")

  const note = !event.editable
    ? t("google.calendar.panel.readOnly")
    : !canEdit
      ? t("google.calendar.panel.multiDay")
      : event.recurring
        ? t("google.calendar.panel.occurrenceOnly")
        : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <span className="eyebrow flex items-center gap-1.5 pe-8">
          <GoogleMark />
          <span>{when}</span>
        </span>
        <SheetTitle className="font-display mt-1 text-xl leading-snug">
          <span dir="auto">{title}</span>
        </SheetTitle>
        {event.location ? (
          <SheetDescription className="flex items-center gap-1.5">
            <MapPinIcon className="size-3.5 shrink-0" />
            {isUrl(event.location) ? (
              <a
                href={event.location}
                target="_blank"
                rel="noreferrer"
                className="truncate underline underline-offset-2 hover:text-foreground"
                dir="ltr"
              >
                {event.location}
              </a>
            ) : (
              <span dir="auto" className="truncate">
                {event.location}
              </span>
            )}
          </SheetDescription>
        ) : null}
      </SheetHeader>

      <SheetPanel>
        <div className="flex flex-col gap-6">
          <section className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <h3 className="eyebrow pt-1">{t("google.calendar.panel.calendar")}</h3>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: event.color ?? "var(--foreground-muted)" }}
              />
              <span dir="auto" className="truncate">
                {event.calendarTitle}
              </span>
            </div>
            {event.description ? (
              <>
                <h3 className="eyebrow pt-1">{t("google.calendar.panel.description")}</h3>
                <p
                  dir="auto"
                  className="text-sm break-words whitespace-pre-wrap text-foreground-secondary"
                >
                  {event.description}
                </p>
              </>
            ) : null}
          </section>

          <div className="flex flex-col gap-2">
            {note ? (
              <p className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-foreground-secondary">
                <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                {note}
              </p>
            ) : null}
            <p className="flex items-center gap-2 text-xs text-foreground-muted">
              <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {t("google.calendar.panel.private")}
            </p>
          </div>

          {/* A timed, single-day event can become a workspace meeting, with minutes and action items. */}
          {!event.allDay && span.startKey === span.endKey ? (
            <section
              className="flex flex-col gap-3 rounded-md border border-brand-border bg-brand-surface-subtle p-4"
              data-testid="add-to-workspace"
            >
              <div className="flex items-start gap-2">
                <UsersIcon className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden="true" />
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium">
                    {t("google.calendar.panel.addTitle", { workspace: addToWorkspace.workspaceName })}
                  </p>
                  <p className="text-xs text-foreground-secondary">
                    {addToWorkspace.allowed
                      ? t("google.calendar.panel.addHint")
                      : t("google.calendar.panel.addAskAdmin")}
                  </p>
                </div>
              </div>
              {addToWorkspace.allowed ? (
                <div>
                  <Button
                    size="sm"
                    loading={addToWorkspace.pending}
                    onClick={() => addToWorkspace.onAdd(span)}
                  >
                    {t("google.calendar.panel.add")}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}

          {event.htmlLink ? (
            <a
              href={event.htmlLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-brand-ink hover:underline"
              data-testid="open-in-google"
            >
              {t("google.calendar.panel.openInGoogle")}
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      </SheetPanel>

      <SheetFooter className="flex-wrap justify-between gap-2">
        <>
          <div>
            {event.editable ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive-foreground"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon />
                {t("google.calendar.panel.delete")}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.close")}
            </Button>
            {canEdit ? (
              <Button variant="outline" onClick={() => onEdit(span)}>
                <PencilIcon />
                {t("google.calendar.panel.edit")}
              </Button>
            ) : null}
          </div>
        </>
      </SheetFooter>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("google.calendar.panel.deleteTitle")}
        description={
          event.recurring
            ? t("google.calendar.panel.deleteOccurrenceBody", { title })
            : t("google.calendar.panel.deleteBody", { title })
        }
        confirmLabel={t("google.calendar.panel.delete")}
        onConfirm={async () => {
          await deleteEvent.mutateAsync({ calendarId: event.calendarId, id: event.id })
          toastManager.add({ type: "success", title: t("google.calendar.panel.deleted") })
          onClose()
        }}
      />
    </div>
  )
}
