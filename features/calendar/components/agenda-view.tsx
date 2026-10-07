"use client"

import { MapPinIcon } from "lucide-react"
import { TaskChip } from "@/features/calendar/components/calendar-items"
import { toDateKey } from "@/features/calendar/lib/calendar-utils"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, Task } from "@/lib/types"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

/** Phone layout: the visible days as a list, skipping empty days. */
export function AgendaView({
  days,
  meetings,
  tasks,
  onOpenMeeting,
  onOpenTask,
}: {
  days: Date[]
  meetings: Meeting[]
  tasks: Task[]
  onOpenMeeting: (meeting: Meeting) => void
  onOpenTask: (task: Task) => void
}): React.ReactElement {
  const { intl, t } = useLocale()
  const todayKey = toDateKey(useNow())
  const heading = new Intl.DateTimeFormat(intl, { weekday: "long", day: "numeric", month: "short" })

  const groups = days
    .map((day) => {
      const key = toDateKey(day)
      return {
        day,
        key,
        meetings: meetings.filter((m) => m.date === key),
        tasks: tasks.filter((task) => task.dueDate === key),
      }
    })
    .filter((g) => g.meetings.length > 0 || g.tasks.length > 0)

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
            {group.meetings.map((meeting) => (
              <button
                key={meeting.id}
                type="button"
                data-meeting-id={meeting.id}
                onClick={() => onOpenMeeting(meeting)}
                className="flex cursor-pointer gap-3 rounded-md border p-3 text-start transition-colors hover:bg-surface-muted"
              >
                <span
                  className="w-24 shrink-0 text-xs text-foreground-secondary tabular-nums"
                  dir="ltr"
                >
                  {meeting.startTime}–{meeting.endTime}
                </span>
                <span className="min-w-0">
                  <span dir="auto" className="block truncate text-sm font-medium">
                    {meeting.title}
                  </span>
                  {meeting.location ? (
                    <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-foreground-muted">
                      <MapPinIcon className="size-3 shrink-0" />
                      <span className="truncate">{meeting.location}</span>
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
            {group.tasks.map((task) => (
              <TaskChip key={task.id} task={task} onOpen={onOpenTask} className="py-1.5 text-sm" />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
