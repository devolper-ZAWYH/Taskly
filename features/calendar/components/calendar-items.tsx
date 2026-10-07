"use client"

import { CircleCheckIcon, CircleIcon } from "lucide-react"
import { formatTaskRef, isOverdue } from "@/features/tasks/lib/task-meta"
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
