"use client"

import { MapPinIcon } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { eventBarStyle, GoogleMark } from "@/features/google/google-mark"
import { useGoogleConnected, usePersonalEvents, usePersonalTasks } from "@/features/google/hooks"
import {
  spanSortKey,
  spansOn,
  spanTimesOn,
  toEventSpans,
  type EventSpan,
} from "@/features/google/personal-events"
import {
  isPersonalOverdue,
  PersonalTaskCheck,
  PersonalTaskDialog,
  type PersonalTaskDialogState,
} from "@/features/google/personal-tasks"
import { useWorkspacePath } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { PersonalTask } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The viewer's Google items for `today` (their local date): open personal
 * tasks due today or earlier, and today's personal events. Empty when not
 * connected.
 */
export function useGoogleToday(today: string): { tasks: PersonalTask[]; events: EventSpan[] } {
  const connected = useGoogleConnected()
  const tasks = usePersonalTasks(false, connected)
  const events = usePersonalEvents({ from: today, to: today }, connected)
  return React.useMemo(() => {
    if (!connected) return { tasks: [], events: [] }
    return {
      tasks: (tasks.data ?? [])
        .filter((task) => !task.completed && task.dueDate !== "" && task.dueDate <= today)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      events: spansOn(toEventSpans(events.data ?? []), today).sort((a, b) =>
        spanSortKey(a, today).localeCompare(spanSortKey(b, today)),
      ),
    }
  }, [connected, tasks.data, events.data, today])
}

/** Group heading in the dashboard's lists, marked as Google. */
function GoogleHeading({ label, count }: { label: string; count: number }): React.ReactElement {
  return (
    <p className="eyebrow flex items-center gap-1.5 border-b bg-surface-muted px-4 py-2">
      <GoogleMark />
      {label} · {count}
    </p>
  )
}

/** "My tasks" card: personal Google tasks that are overdue or due today. */
export function GoogleTaskGroup({
  tasks,
  today,
}: {
  tasks: PersonalTask[]
  today: string
}): React.ReactElement | null {
  const { t, formatDate } = useLocale()
  const [dialog, setDialog] = React.useState<PersonalTaskDialogState | null>(null)
  if (tasks.length === 0 && !dialog) return null
  return (
    <div data-testid="dashboard-google-tasks">
      <GoogleHeading label={t("google.dashboard.tasks")} count={tasks.length} />
      <ul>
        {tasks.map((task) => {
          const overdue = isPersonalOverdue(task, today)
          return (
            <li key={task.id} className="flex items-center gap-2 border-b ps-2 pe-4 last:border-b-0">
              <PersonalTaskCheck task={task} />
              <button
                type="button"
                onClick={() => setDialog({ mode: "edit", task })}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 text-start"
              >
                {/* Inline dir="auto": the title reads in its own direction but stays at the row's start. */}
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span dir="auto">{task.title || t("google.noTitle")}</span>
                </span>
                <span
                  dir="auto"
                  className="hidden max-w-32 shrink-0 truncate text-xs text-foreground-muted sm:inline"
                >
                  {task.tasklistTitle}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs",
                    overdue ? "font-medium text-destructive-foreground" : "text-foreground-muted",
                  )}
                >
                  {overdue ? formatDate(task.dueDate) : t("dashboard.today")}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <PersonalTaskDialog state={dialog} onClose={() => setDialog(null)} />
    </div>
  )
}

/** Meetings card: today's personal Google events, above the workspace meetings. */
export function GoogleEventGroup({
  events,
  today,
}: {
  events: EventSpan[]
  today: string
}): React.ReactElement | null {
  const { t } = useLocale()
  const wsPath = useWorkspacePath()
  if (events.length === 0) return null
  return (
    <div className="border-b" data-testid="dashboard-google-events">
      <GoogleHeading label={t("google.dashboard.events")} count={events.length} />
      <ul>
        {events.map((span) => {
          const times = spanTimesOn(span, today)
          return (
            <li key={span.event.id} className="border-b last:border-b-0">
              <Link
                href={wsPath(`/calendar?view=week&date=${today}`)}
                className="flex gap-3 border-s-[3px] px-4 py-2.5 transition-colors hover:bg-surface-hover"
                style={eventBarStyle(span.event.color)}
              >
                <span className="w-20 shrink-0 text-xs leading-5 text-foreground-muted tabular-nums">
                  {times ? (
                    <span dir="ltr">
                      {times.from}–{times.to}
                    </span>
                  ) : (
                    t("google.calendar.allDay")
                  )}
                </span>
                <span className="min-w-0">
                  <span dir="auto" className="block truncate text-sm font-medium">
                    {span.event.title || t("google.noTitle")}
                  </span>
                  {span.event.location ? (
                    <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-foreground-muted">
                      <MapPinIcon className="size-3 shrink-0" />
                      <span dir="auto" className="truncate">
                        {span.event.location}
                      </span>
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
