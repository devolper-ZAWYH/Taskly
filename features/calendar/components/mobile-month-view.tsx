"use client"

import { AgendaView } from "@/features/calendar/components/agenda-view"
import { getMonthGridDays, toDateKey } from "@/features/calendar/lib/calendar-utils"
import { spansOn, type EventSpan } from "@/features/google/personal-events"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, Task } from "@/lib/types"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

/**
 * Phone calendar: a compact month grid (dots mark meetings, personal Google
 * events and due tasks) and the selected day's items underneath.
 */
export function MobileMonthView({
  month,
  selectedKey,
  meetings,
  tasks,
  events = [],
  onSelect,
  onOpenMeeting,
  onOpenTask,
  onOpenEvent,
}: {
  month: Date
  selectedKey: string
  meetings: Meeting[]
  tasks: Task[]
  events?: EventSpan[]
  onSelect: (dateKey: string) => void
  onOpenMeeting: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
  onOpenEvent?: (span: EventSpan) => void
}): React.ReactElement {
  const { intl } = useLocale()
  const todayKey = toDateKey(useNow())
  const days = getMonthGridDays(month)
  const weekday = new Intl.DateTimeFormat(intl, { weekday: "narrow" })
  const full = new Intl.DateTimeFormat(intl, { weekday: "long", day: "numeric", month: "long" })
  const selected = days.find((d) => toDateKey(d) === selectedKey) ?? month

  return (
    <div className="flex flex-col gap-4" data-testid="mobile-month">
      <div className="rounded-md border p-2">
        <div className="grid grid-cols-7 pb-1">
          {days.slice(0, 7).map((day) => (
            <span key={day.getDay()} className="eyebrow py-1 text-center">
              {weekday.format(day)}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-1">
          {days.map((day) => {
            const key = toDateKey(day)
            const inMonth = day.getMonth() === month.getMonth()
            const hasMeeting = meetings.some((m) => m.date === key)
            const hasTask = tasks.some((task) => task.dueDate === key)
            const hasEvent = spansOn(events, key).length > 0
            const isSelected = key === selectedKey
            const isToday = key === todayKey
            return (
              <button
                key={key}
                type="button"
                data-date={key}
                aria-pressed={isSelected}
                aria-label={full.format(day)}
                onClick={() => onSelect(key)}
                className="flex cursor-pointer flex-col items-center gap-1 py-1"
              >
                <span
                  className={cn(
                    "grid size-9 place-items-center rounded-full text-sm tabular-nums transition-colors",
                    isSelected
                      ? "bg-brand font-semibold text-brand-foreground"
                      : isToday
                        ? "font-semibold text-foreground ring-1 ring-foreground"
                        : inMonth
                          ? "text-foreground hover:bg-surface-hover"
                          : "text-foreground-disabled",
                  )}
                >
                  {day.getDate()}
                </span>
                <span className="flex h-1.5 gap-1" aria-hidden="true">
                  {hasMeeting ? <span className="size-1.5 rounded-full bg-brand" /> : null}
                  {hasEvent ? (
                    <span className="size-1.5 rounded-full border border-foreground-secondary" />
                  ) : null}
                  {hasTask ? <span className="size-1.5 rounded-full bg-foreground-muted" /> : null}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <AgendaView
        days={[selected]}
        meetings={meetings}
        tasks={tasks}
        events={events}
        onOpenMeeting={onOpenMeeting}
        onOpenTask={onOpenTask}
        onOpenEvent={onOpenEvent}
      />
    </div>
  )
}
