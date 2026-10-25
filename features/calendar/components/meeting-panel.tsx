"use client"

import {
  LanguagesIcon,
  Loader2Icon,
  MapPinIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"
import * as React from "react"
import { UserAvatar } from "@/components/shell/user-avatar"
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
import {
  useDeleteMeeting,
  useMeeting,
  useRetranslateMeeting,
  useMeetingTasks,
} from "@/features/calendar/hooks/use-meetings"
import { SyncedToGoogle } from "@/features/google/synced-marker"
import { LiveTranscriptSection } from "@/features/live/live-transcript-section"
import { MeetingMinutesSection } from "@/features/minutes/meeting-minutes-section"
import { AssigneeStack } from "@/features/tasks/components/assignees"
import { StatusBadge } from "@/features/tasks/components/task-badges"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { TaskCreateDialog } from "@/features/tasks/components/task-create-dialog"
import { usePeople } from "@/features/tasks/hooks/use-tasks"
import { useViewer } from "@/features/workspace/workspace-context"
import { canEditMeeting } from "@/lib/api/meetings"
import { SessionReviewCard } from "@/features/live/session-review-card"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { FieldTranslation, Meeting, Task } from "@/lib/types"

/** Side panel for one meeting, driven by `?meeting=<id>`. */
export function MeetingPanel({
  meetingId,
  onClose,
  onEdit,
  onOpenTask,
}: {
  meetingId: string | null
  onClose: () => void
  onEdit: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
}): React.ReactElement {
  const { t } = useLocale()
  const query = useMeeting(meetingId)

  return (
    <Sheet open={Boolean(meetingId)} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup className="max-w-xl">
        {query.data ? (
          <MeetingDetail
            key={query.data.id}
            meeting={query.data}
            onClose={onClose}
            onEdit={onEdit}
            onOpenTask={onOpenTask}
          />
        ) : query.isError ? (
          <SheetHeader>
            <SheetTitle className="font-display text-xl">{t("meetings.panel.notFound")}</SheetTitle>
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

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function MeetingDetail({
  meeting,
  onClose,
  onEdit,
  onOpenTask,
}: {
  meeting: Meeting
  onClose: () => void
  onEdit: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
}): React.ReactElement {
  const { t, intl } = useLocale()
  const me = useViewer()
  const { data: people } = usePeople()
  const actionItems = useMeetingTasks(meeting.id)
  const deleteMeeting = useDeleteMeeting()
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)

  const canEdit = canEditMeeting(me)
  const organizer = people?.find((p) => p.id === meeting.organizerId)
  const attendees = meeting.attendeeIds
    .map((id) => people?.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
  const when = new Intl.DateTimeFormat(intl, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${meeting.date}T00:00:00`))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <span className="eyebrow pe-8">
          {when} ·{" "}
          <span dir="ltr">
            {meeting.startTime}–{meeting.endTime}
          </span>
        </span>
        <SheetTitle className="font-display mt-1 text-xl leading-snug" dir="auto">
          {meeting.title}
        </SheetTitle>
        {meeting.translations?.title ? (
          <Translated meetingId={meeting.id} translation={meeting.translations.title} canRetry={canEdit} />
        ) : null}
        {meeting.location ? (
          <SheetDescription className="flex items-center gap-1.5">
            <MapPinIcon className="size-3.5 shrink-0" />
            {isUrl(meeting.location) ? (
              <a
                href={meeting.location}
                target="_blank"
                rel="noreferrer"
                className="truncate underline underline-offset-2 hover:text-foreground"
                dir="ltr"
              >
                {meeting.location}
              </a>
            ) : (
              <span className="truncate">{meeting.location}</span>
            )}
          </SheetDescription>
        ) : null}
        <SyncedToGoogle
          involved={meeting.organizerId === me.id || meeting.attendeeIds.includes(me.id)}
        />
      </SheetHeader>

      <SheetPanel>
        <div className="flex flex-col gap-7">
          <section className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <h3 className="eyebrow pt-1">{t("meetings.panel.organizer")}</h3>
            <div className="flex items-center gap-2 text-sm">
              {organizer ? (
                <>
                  <UserAvatar
                    name={organizer.name}
                    src={organizer.avatarUrl}
                    size="sm"
                    className="ring-0"
                  />
                  {organizer.name}
                </>
              ) : (
                "—"
              )}
            </div>
            <h3 className="eyebrow pt-1">{t("meetings.panel.attendees")}</h3>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {attendees.length === 0
                ? "—"
                : attendees.map((p) => (
                    <span key={p.id} className="flex items-center gap-2">
                      <UserAvatar
                        name={p.name}
                        src={p.avatarUrl}
                        inactive={!p.active}
                        size="sm"
                        className="ring-0"
                      />
                      <span className={p.active ? "" : "text-foreground-muted"}>{p.name}</span>
                    </span>
                  ))}
            </div>
            {meeting.notes ? (
              <>
                <h3 className="eyebrow pt-1">{t("meetings.panel.notes")}</h3>
                <div className="flex min-w-0 flex-col gap-3">
                  <p dir="auto" className="text-sm whitespace-pre-wrap text-foreground-secondary">
                    {meeting.notes}
                  </p>
                  {meeting.translations?.notes ? (
                    <Translated
                      meetingId={meeting.id}
                      translation={meeting.translations.notes}
                      canRetry={canEdit}
                      block
                    />
                  ) : null}
                </div>
              </>
            ) : null}
          </section>

          <LiveTranscriptSection meeting={meeting} />

          <SessionReviewCard meeting={meeting} />

          <MeetingMinutesSection meeting={meeting} people={people} />

          <section className="flex flex-col gap-3 border-t pt-6" data-testid="action-items">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl">{t("meetings.panel.actionItems")}</h2>
                <p className="text-xs text-foreground-muted">
                  {t("meetings.panel.actionItemsHint")}
                </p>
              </div>
              {canEdit ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <PlusIcon />
                  {t("meetings.panel.createTask")}
                </Button>
              ) : null}
            </div>
            {actionItems.data && actionItems.data.length > 0 ? (
              <ul className="flex flex-col border-t">
                {actionItems.data.map((task) => (
                  <li key={task.id} className="border-b">
                    <button
                      type="button"
                      onClick={() => onOpenTask(task)}
                      className="flex w-full cursor-pointer items-center gap-3 px-1 py-2.5 text-start transition-colors hover:bg-surface-muted"
                    >
                      <span
                        dir="auto"
                        className="min-w-0 flex-1 truncate text-start text-sm font-medium"
                      >
                        {task.title}
                      </span>
                      <AssigneeStack ids={task.assigneeIds} people={people} />
                      <StatusBadge status={task.status} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-foreground-muted">
                {t("meetings.panel.actionItemsEmpty")}
              </p>
            )}
          </section>
        </div>
      </SheetPanel>

      <SheetFooter className="flex-wrap justify-between gap-2">
        <>
          <div>
            {canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive-foreground"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon />
                {t("meetings.panel.delete")}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.close")}
            </Button>
            {canEdit ? (
              <Button variant="outline" onClick={() => onEdit(meeting)}>
                <PencilIcon />
                {t("meetings.panel.edit")}
              </Button>
            ) : null}
          </div>
        </>
      </SheetFooter>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("meetings.panel.deleteTitle")}
        description={t("meetings.panel.deleteBody", { title: meeting.title })}
        confirmLabel={t("meetings.panel.delete")}
        onConfirm={async () => {
          await deleteMeeting.mutateAsync(meeting.id)
          toastManager.add({ type: "success", title: t("meetings.panel.deleted") })
          onClose()
        }}
      />

      <TaskCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={{
          // Attendees become assignees; deactivated people can't be assigned.
          assigneeIds: attendees.filter((p) => p.active).map((p) => p.id),
          // Follow-up work starts when the meeting ends.
          startDate: meeting.date,
          startTime: meeting.endTime,
          dueDate: meeting.date,
          meetingId: meeting.id,
        }}
      />
    </div>
  )
}

/**
 * A field in the other language: the machine translation, or its progress.
 * Administrators can run it again when it failed. `block` for the agenda.
 */
function Translated({
  meetingId,
  translation,
  canRetry,
  block = false,
}: {
  meetingId: string
  translation: FieldTranslation
  canRetry: boolean
  block?: boolean
}): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const retry = useRetranslateMeeting()
  const label = (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium tracking-wide text-foreground-muted uppercase">
      <LanguagesIcon className="size-3" aria-hidden="true" />
      {t(`meetings.panel.translation.${translation.lang}`)}
      {translation.status === "done" ? ` · ${t("meetings.panel.translation.machine")}` : ""}
    </span>
  )
  return (
    <div
      className={block ? "flex flex-col gap-1 rounded-md border border-dashed p-3" : "mt-1 flex flex-col gap-0.5"}
      data-testid="meeting-translation"
    >
      {label}
      {translation.status === "done" ? (
        <p
          dir={translation.lang === "ar" ? "rtl" : "ltr"}
          lang={translation.lang}
          className={
            block
              ? "text-sm whitespace-pre-wrap text-foreground-secondary"
              : "text-sm text-foreground-secondary"
          }
        >
          {translation.text}
        </p>
      ) : translation.status === "pending" ? (
        <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          {t("meetings.panel.translation.pending")}
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-xs text-destructive-foreground">
          {t("meetings.panel.translation.failed")}
          {canRetry ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              loading={retry.isPending}
              onClick={() =>
                retry.mutate(meetingId, {
                  onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
                })
              }
            >
              <RotateCcwIcon />
              {t("meetings.panel.translation.retry")}
            </Button>
          ) : null}
        </p>
      )}
    </div>
  )
}
