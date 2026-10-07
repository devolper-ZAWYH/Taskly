"use client"

import { MeetingChip, TaskChip } from "@/features/calendar/components/calendar-items"
import { getMonthGridDays, toDateKey } from "@/features/calendar/lib/calendar-utils"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, Task } from "@/lib/types"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

const MAX_ITEMS = 3

export function MonthView({
  month,
  meetings,
  tasks,
  onOpenMeeting,
  onOpenTask,
  onCreateAt,
  onShowDay,
}: {
  month: Date
  meetings: Meeting[]
  tasks: Task[]
  onOpenMeeting: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
  /** Only for people who may create meetings. */
  onCreateAt?: (dateKey: string) => void
  onShowDay: (day: Date) => void
}): React.ReactElement {
  const { intl, t } = useLocale()
  const days = getMonthGridDays(month)
  const todayKey = toDateKey(useNow())
  const weekday = new Intl.DateTimeFormat(intl, { weekday: "short" })

  return (
    <div className="border-s border-t">
      <div className="grid grid-cols-7">
        {days.slice(0, 7).map((day) => (
          <div key={day.getDay()} className="eyebrow border-e border-b px-2 py-2">
            {weekday.format(day)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = toDateKey(day)
          const dayMeetings = meetings.filter((m) => m.date === key)
          const dayTasks = tasks.filter((task) => task.dueDate === key)
          const items = [
            ...dayMeetings.map((m) => ({ kind: "meeting" as const, m })),
            ...dayTasks.map((task) => ({ kind: "task" as const, task })),
          ]
          const hidden = items.length - MAX_ITEMS
          const inMonth = day.getMonth() === month.getMonth()
          return (
            <div
              key={key}
              data-date={key}
              onClick={onCreateAt ? () => onCreateAt(key) : undefined}
              className={cn(
                "flex min-h-28 flex-col gap-1 border-e border-b p-1.5 transition-colors",
                onCreateAt && "cursor-pointer hover:bg-surface-muted",
                !inMonth && "bg-surface-muted/50",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-6 items-center justify-center self-start rounded-full text-xs tabular-nums",
                  key === todayKey
                    ? "bg-foreground font-semibold text-background"
                    : inMonth
                      ? "text-foreground"
                      : "text-foreground-disabled",
                )}
              >
                {day.getDate()}
              </span>
              {items
                .slice(0, hidden > 0 ? MAX_ITEMS - 1 : MAX_ITEMS)
                .map((item) =>
                  item.kind === "meeting" ? (
                    <MeetingChip key={item.m.id} meeting={item.m} onOpen={onOpenMeeting} />
                  ) : (
                    <TaskChip key={item.task.id} task={item.task} onOpen={onOpenTask} />
                  ),
                )}
              {hidden > 0 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onShowDay(day)
                  }}
                  className="cursor-pointer self-start px-1 text-xs font-medium text-foreground-secondary hover:text-foreground hover:underline"
                >
                  {t("calendar.more", { n: hidden + 1 })}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
