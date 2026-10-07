"use client"

import { TaskChip } from "@/features/calendar/components/calendar-items"
import {
  currentTimePercentage,
  END_HOUR,
  getWeekDays,
  layoutMeetings,
  START_HOUR,
  toDateKey,
} from "@/features/calendar/lib/calendar-utils"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, Task } from "@/lib/types"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

const HOUR_PX = 52
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)

export function WeekView({
  date,
  meetings,
  tasks,
  showTasks,
  onOpenMeeting,
  onOpenTask,
  onCreateAt,
}: {
  date: Date
  meetings: Meeting[]
  tasks: Task[]
  showTasks: boolean
  onOpenMeeting: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
  /** Only for people who may create meetings. */
  onCreateAt?: (dateKey: string, hour?: number) => void
}): React.ReactElement {
  const { intl, t } = useLocale()
  const now = useNow()
  const days = getWeekDays(date)
  const todayKey = toDateKey(now)
  const nowPct = currentTimePercentage(now)
  const weekday = new Intl.DateTimeFormat(intl, { weekday: "short" })
  const cols = "grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"

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

      {/* Task due dates (all-day row) */}
      {showTasks ? (
        <div className={cn(cols, "border-b")}>
          <div className="eyebrow self-center px-1 text-center">{t("calendar.due")}</div>
          {days.map((day) => {
            const key = toDateKey(day)
            return (
              <div key={key} className="flex min-h-9 flex-col gap-1 border-s p-1">
                {tasks
                  .filter((task) => task.dueDate === key)
                  .map((task) => (
                    <TaskChip key={task.id} task={task} onOpen={onOpenTask} />
                  ))}
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
              {layoutMeetings(meetings, key).map(({ meeting, top, height, left, width }) => {
                // Short meetings (under ~45 min) get a single line so text isn't clipped.
                const compact = (height / 100) * HOURS.length * HOUR_PX < 38
                return (
                  <button
                    key={meeting.id}
                    type="button"
                    data-meeting-id={meeting.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenMeeting(meeting)
                    }}
                    className={cn(
                      "absolute z-10 flex cursor-pointer overflow-hidden rounded-sm border border-background bg-surface-strong px-1.5 text-start text-xs transition-colors hover:bg-foreground hover:text-background",
                      compact ? "items-center gap-1.5 py-0 leading-none" : "flex-col py-1",
                    )}
                    style={{
                      top: `${top}%`,
                      height: `${height}%`,
                      insetInlineStart: `${left}%`,
                      width: `${width}%`,
                    }}
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
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
