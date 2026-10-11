"use client"

import { CircleCheckIcon, CircleIcon } from "lucide-react"
import { eventBarStyle, GoogleMark } from "@/features/google/google-mark"
import { spanTimesOn, type EventSpan } from "@/features/google/personal-events"
import { formatTaskRef, isOverdue } from "@/features/tasks/lib/task-meta"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, Task } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Compact meeting chip (month view / agenda). */
export function MeetingChip({
  meeting,
  onOpen,
  className,
}: {
  meeting: Meeting
  onOpen: (meeting: Meeting) => void
  className?: string
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
        "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm bg-surface-strong px-1.5 py-0.5 text-start text-xs transition-colors hover:bg-foreground hover:text-background",
        className,
      )}
    >
      <span className="shrink-0 tabular-nums opacity-70" dir="ltr">
        {meeting.startTime}
      </span>
      <span dir="auto" className="truncate font-medium">
        {meeting.title}
      </span>
    </button>
  )
}

/** Task due-date chip. */
export function TaskChip({
  task,
  onOpen,
  className,
}: {
  task: Task
  onOpen: (task: Task) => void
  className?: string
}): React.ReactElement {
  const done = task.status === "completed"
  const overdue = isOverdue(task)
  const Icon = done ? CircleCheckIcon : CircleIcon
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(task)
      }}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm border border-dashed border-foreground/30 px-1.5 py-0.5 text-start text-xs transition-colors hover:border-foreground",
        done && "text-foreground-muted line-through",
        overdue && "border-destructive/50 text-destructive-foreground",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" />
      <span className="shrink-0 font-mono text-[10px] opacity-70">
        {formatTaskRef(task.number)}
      </span>
      <span dir="auto" className="truncate">
        {task.title}
      </span>
    </button>
  )
}

/**
 * Personal Google event chip: white with its calendar's colour bar and a "G"
 * mark, so it never reads as a workspace meeting.
 */
export function PersonalEventChip({
  span,
  dayKey,
  onOpen,
  className,
}: {
  span: EventSpan
  dayKey: string
  onOpen: (span: EventSpan) => void
  className?: string
}): React.ReactElement {
  const { t } = useLocale()
  // The start time only on the day it starts; later days of an overnight event just show the title.
  const times = dayKey === span.startKey ? spanTimesOn(span, dayKey) : null
  return (
    <button
      type="button"
      data-google-event-id={span.event.id}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(span)
      }}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm border border-s-[3px] bg-background px-1.5 py-0.5 text-start text-xs transition-colors hover:bg-surface-hover",
        className,
      )}
      style={eventBarStyle(span.event.color)}
    >
      <GoogleMark />
      {times ? (
        <span className="shrink-0 tabular-nums opacity-70" dir="ltr">
          {times.from}
        </span>
      ) : null}
      <span dir="auto" className="truncate font-medium">
        {span.event.title || t("google.noTitle")}
      </span>
    </button>
  )
}
