"use client"

import { MapPinIcon } from "lucide-react"
import { TaskChip } from "@/features/calendar/components/calendar-items"
import { toDateKey } from "@/features/calendar/lib/calendar-utils"
import { eventBarStyle, GoogleMark } from "@/features/google/google-mark"
import {
  spanSortKey,
  spansOn,
  spanTimesOn,
  type EventSpan,
} from "@/features/google/personal-events"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, Task } from "@/lib/types"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

type Entry =
  | { kind: "meeting"; meeting: Meeting; at: string }
  | { kind: "event"; span: EventSpan; at: string }

/** Phone layout: the visible days as a list, skipping empty days. */
export function AgendaView({
  days,
  meetings,
  tasks,
  events = [],
  onOpenMeeting,
  onOpenTask,
  onOpenEvent,
}: {
  days: Date[]
  meetings: Meeting[]
  tasks: Task[]
  /** The viewer's own Google events (only theirs, only when shown). */
  events?: EventSpan[]
  onOpenMeeting: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
  onOpenEvent?: (span: EventSpan) => void
}): React.ReactElement {
  const { intl, t } = useLocale()
  const todayKey = toDateKey(useNow())
  const heading = new Intl.DateTimeFormat(intl, { weekday: "long", day: "numeric", month: "short" })

  const groups = days
    .map((day) => {
      const key = toDateKey(day)
      // All-day events first, then meetings and timed events by start time.
      const entries: Entry[] = [
        ...meetings
          .filter((m) => m.date === key)
          .map((meeting) => ({ kind: "meeting" as const, meeting, at: meeting.startTime })),
        ...spansOn(events, key).map((span) => ({
          kind: "event" as const,
          span,
          at: spanSortKey(span, key),
        })),
      ].sort((a, b) => a.at.localeCompare(b.at))
      return {
        day,
        key,
        entries,
        tasks: tasks.filter((task) => task.dueDate === key),
      }
    })
    .filter((g) => g.entries.length > 0 || g.tasks.length > 0)

  if (groups.length === 0) {
    return (
      <p className="border-t py-16 text-center text-sm text-foreground-muted">
        {t("calendar.empty")}
      </p>
    )
  }

  return (
    <div className="flex flex-col border-t">
      {groups.map((group) => (
        <section key={group.key} className="border-b py-4">
          <h3 className={cn("eyebrow mb-3", group.key === todayKey && "text-foreground")}>
            {heading.format(group.day)}
          </h3>
          <div className="flex flex-col gap-2">
            {group.entries.map((entry) =>
              entry.kind === "meeting" ? (
                <AgendaRow
                  key={entry.meeting.id}
                  data-meeting-id={entry.meeting.id}
                  time={
                    <span dir="ltr">
                      {entry.meeting.startTime}–{entry.meeting.endTime}
                    </span>
                  }
                  title={entry.meeting.title}
                  location={entry.meeting.location}
                  onClick={() => onOpenMeeting(entry.meeting)}
                />
              ) : (
                <EventRow
                  key={`google-${entry.span.event.id}`}
                  span={entry.span}
                  dayKey={group.key}
                  onOpen={onOpenEvent ?? (() => {})}
                />
              ),
            )}
            {group.tasks.map((task) => (
              <TaskChip key={task.id} task={task} onOpen={onOpenTask} className="py-1.5 text-sm" />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function AgendaRow({
  time,
  title,
  location,
  onClick,
  className,
  style,
  mark,
  ...rest
}: {
  time: React.ReactNode
  title: string
  location: string
  onClick: () => void
  className?: string
  style?: React.CSSProperties
  mark?: React.ReactNode
  "data-meeting-id"?: string
  "data-google-event-id"?: string
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex cursor-pointer gap-3 rounded-md border p-3 text-start transition-colors hover:bg-surface-muted",
        className,
      )}
      style={style}
      {...rest}
    >
      <span className="w-24 shrink-0 text-xs text-foreground-secondary tabular-nums">{time}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          {mark}
          <span dir="auto" className="block truncate text-sm font-medium">
            {title}
          </span>
        </span>
        {location ? (
          <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-foreground-muted">
            <MapPinIcon className="size-3 shrink-0" />
            <span dir="auto" className="truncate">
              {location}
            </span>
          </span>
        ) : null}
      </span>
    </button>
  )
}

/** A personal Google event: same row shape as a meeting, with its colour bar and "G" mark. */
function EventRow({
  span,
  dayKey,
  onOpen,
}: {
  span: EventSpan
  dayKey: string
  onOpen: (span: EventSpan) => void
}): React.ReactElement {
  const { t } = useLocale()
  const times = spanTimesOn(span, dayKey)
  return (
    <AgendaRow
      data-google-event-id={span.event.id}
      time={
        times ? (
          <span dir="ltr">
            {times.from}–{times.to}
          </span>
        ) : (
          t("google.calendar.allDay")
        )
      }
      title={span.event.title || t("google.noTitle")}
      location={span.event.location}
      onClick={() => onOpen(span)}
      className="border-s-[3px]"
      style={eventBarStyle(span.event.color)}
      mark={<GoogleMark />}
    />
  )
}
