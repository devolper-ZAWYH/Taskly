"use client"

import { PersonalEventChip, TaskChip } from "@/features/calendar/components/calendar-items"
import {
  currentTimePercentage,
  END_HOUR,
  getWeekDays,
  layoutTimed,
  meetingSlot,
  START_HOUR,
  toDateKey,
  toMinutes,
  type TimedSlot,
} from "@/features/calendar/lib/calendar-utils"
import { eventBarStyle, GoogleMark } from "@/features/google/google-mark"
import { spansOn, spanTimesOn, type EventSpan } from "@/features/google/personal-events"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, Task } from "@/lib/types"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

const HOUR_PX = 52
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)

type GridItem = { kind: "meeting"; meeting: Meeting } | { kind: "event"; span: EventSpan }

/** A day's meetings and timed personal events, as slots for the shared overlap layout. */
function daySlots(meetings: Meeting[], events: EventSpan[], dayKey: string): TimedSlot<GridItem>[] {
  const slots: TimedSlot<GridItem>[] = meetings
    .filter((m) => m.date === dayKey)
    .map((m) => ({ ...meetingSlot(m), item: { kind: "meeting", meeting: m } }))
  for (const span of spansOn(events, dayKey)) {
    const times = span.allDayRow ? null : spanTimesOn(span, dayKey)
    if (!times) continue
    slots.push({
      item: { kind: "event", span },
      start: toMinutes(times.from),
      end: toMinutes(times.to),
    })
  }
  return slots
}

export function WeekView({
  date,
  meetings,
  tasks,
  showTasks,
  events = [],
  onOpenMeeting,
  onOpenTask,
  onOpenEvent,
  onCreateAt,
}: {
  date: Date
  meetings: Meeting[]
  tasks: Task[]
  showTasks: boolean
  /** The viewer's own Google events (only theirs, only when shown). */
  events?: EventSpan[]
  onOpenMeeting: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
  onOpenEvent?: (span: EventSpan) => void
  /** Only for people who may create meetings or events. */
  onCreateAt?: (dateKey: string, hour?: number) => void
}): React.ReactElement {
  const { intl, t } = useLocale()
  const now = useNow()
  const days = getWeekDays(date)
  const todayKey = toDateKey(now)
  const nowPct = currentTimePercentage(now)
  const weekday = new Intl.DateTimeFormat(intl, { weekday: "short" })
  const cols = "grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
  const openEvent = onOpenEvent ?? (() => {})

  const allDayEvents = events.filter((s) => s.allDayRow)
  const hasAllDayEvents = days.some((day) => spansOn(allDayEvents, toDateKey(day)).length > 0)

  return (
    <div className="border-t">
      {/* Day headers */}
      <div className={cn(cols, "border-b")}>
        <div />
        {days.map((day) => {
          const key = toDateKey(day)
          return (
            <div key={key} className="border-s px-2 py-2 text-center">
              <div className="eyebrow">{weekday.format(day)}</div>
              <div
                className={cn(
                  "mx-auto mt-1 inline-flex size-8 items-center justify-center rounded-full text-base tabular-nums",
                  key === todayKey ? "bg-foreground font-semibold text-background" : "",
                )}
              >
                {day.getDate()}
              </div>
            </div>
          )
        })}
      </div>

      {/* All-day row: personal all-day events, then task due dates */}
      {showTasks || hasAllDayEvents ? (
        <div className={cn(cols, "border-b")}>
          <div className="eyebrow self-center px-1 text-center">
            {hasAllDayEvents ? t("google.calendar.allDay") : t("calendar.due")}
          </div>
          {days.map((day) => {
            const key = toDateKey(day)
            return (
              <div key={key} className="flex min-h-9 min-w-0 flex-col gap-1 border-s p-1">
                {spansOn(allDayEvents, key).map((span) => (
                  <PersonalEventChip
                    key={span.event.id}
                    span={span}
                    dayKey={key}
                    onOpen={openEvent}
                  />
                ))}
                {showTasks
                  ? tasks
                      .filter((task) => task.dueDate === key)
                      .map((task) => <TaskChip key={task.id} task={task} onOpen={onOpenTask} />)
                  : null}
              </div>
            )
          })}
        </div>
      ) : null}

      {/* Time grid */}
      <div className={cols}>
        <div className="relative" style={{ height: HOURS.length * HOUR_PX }}>
          {HOURS.map((hour, i) => (
            <span
              key={hour}
              className="absolute end-2 -translate-y-1/2 text-[11px] text-foreground-muted tabular-nums"
              style={{ top: i * HOUR_PX }}
              dir="ltr"
            >
              {i === 0 ? "" : `${String(hour).padStart(2, "0")}:00`}
            </span>
          ))}
        </div>
        {days.map((day) => {
          const key = toDateKey(day)
          return (
            <div
              key={key}
              data-date={key}
              className={onCreateAt ? "relative cursor-pointer border-s" : "relative border-s"}
              style={{ height: HOURS.length * HOUR_PX }}
              onClick={(e) => {
                if (!onCreateAt) return
                const rect = e.currentTarget.getBoundingClientRect()
                const hour = START_HOUR + Math.floor((e.clientY - rect.top) / HOUR_PX)
                onCreateAt(key, Math.min(Math.max(hour, START_HOUR), END_HOUR - 1))
              }}
            >
              {HOURS.map((hour, i) => (
                <div
                  key={hour}
                  className="pointer-events-none absolute inset-x-0 border-t border-border-subtle"
                  style={{ top: i * HOUR_PX }}
                />
              ))}
              {key === todayKey && nowPct !== null ? (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-destructive"
                  style={{ top: `${nowPct}%` }}
                />
              ) : null}
              {layoutTimed(daySlots(meetings, events, key)).map(
                ({ item, top, height, left, width }) => {
                  // Short items (under ~45 min) get a single line so text isn't clipped.
                  const compact = (height / 100) * HOURS.length * HOUR_PX < 38
                  const position = {
                    top: `${top}%`,
                    height: `${height}%`,
                    insetInlineStart: `${left}%`,
                    width: `${width}%`,
                  }
                  return item.kind === "meeting" ? (
                    <MeetingBlock
                      key={item.meeting.id}
                      meeting={item.meeting}
                      compact={compact}
                      style={position}
                      onOpen={onOpenMeeting}
                    />
                  ) : (
                    <EventBlock
                      key={`google-${item.span.event.id}`}
                      span={item.span}
                      dayKey={key}
                      compact={compact}
                      style={position}
                      onOpen={openEvent}
                    />
                  )
                },
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MeetingBlock({
  meeting,
  compact,
  style,
  onOpen,
}: {
  meeting: Meeting
  compact: boolean
  style: React.CSSProperties
  onOpen: (meeting: Meeting) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      data-meeting-id={meeting.id}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(meeting)
      }}
      className={cn(
        "absolute z-10 flex cursor-pointer overflow-hidden rounded-sm border border-background bg-surface-strong px-1.5 text-start text-xs transition-colors hover:bg-foreground hover:text-background",
        compact ? "items-center gap-1.5 py-0 leading-none" : "flex-col py-1",
      )}
      style={style}
    >
      {compact ? (
        <span className="shrink-0 opacity-70 tabular-nums" dir="ltr">
          {meeting.startTime}
        </span>
      ) : null}
      <span dir="auto" className="truncate font-semibold">
        {meeting.title}
      </span>
      {compact ? null : (
        <span className="truncate opacity-70 tabular-nums" dir="ltr">
          {meeting.startTime}–{meeting.endTime}
        </span>
      )}
    </button>
  )
}

/** A personal event in the time grid: white, with its calendar's colour bar. */
function EventBlock({
  span,
  dayKey,
  compact,
  style,
  onOpen,
}: {
  span: EventSpan
  dayKey: string
  compact: boolean
  style: React.CSSProperties
  onOpen: (span: EventSpan) => void
}): React.ReactElement {
  const { t } = useLocale()
  const times = spanTimesOn(span, dayKey)
  return (
    <button
      type="button"
      data-google-event-id={span.event.id}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(span)
      }}
      className={cn(
        "absolute z-10 flex cursor-pointer overflow-hidden rounded-sm border border-s-[3px] border-border bg-background px-1.5 text-start text-xs shadow-xs transition-colors hover:bg-surface-hover",
        compact ? "items-center gap-1.5 py-0 leading-none" : "flex-col py-1",
      )}
      style={{ ...style, ...eventBarStyle(span.event.color) }}
    >
      {compact ? (
        <>
          <GoogleMark />
          <span className="shrink-0 opacity-70 tabular-nums" dir="ltr">
            {times?.from}
          </span>
        </>
      ) : null}
      <span className="flex min-w-0 items-center gap-1">
        {compact ? null : <GoogleMark />}
        <span dir="auto" className="truncate font-semibold">
          {span.event.title || t("google.noTitle")}
        </span>
      </span>
      {compact || !times ? null : (
        <span className="truncate opacity-70 tabular-nums" dir="ltr">
          {times.from}–{times.to}
        </span>
      )}
    </button>
  )
}
