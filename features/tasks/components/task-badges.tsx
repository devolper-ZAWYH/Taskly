"use client"

import { Badge } from "@/components/ui/badge"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { TaskPriority, TaskStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Taskly colours: gold = moving, grey = waiting, emerald = done. */
const STATUS_STYLE: Record<TaskStatus, string> = {
  open: "border-foreground/25 bg-transparent text-foreground",
  in_progress: "border-transparent bg-brand-surface text-brand-ink",
  on_hold: "border-transparent bg-surface-strong text-foreground-secondary",
  completed: "border-transparent bg-success text-white",
  cancelled: "border-transparent bg-surface-muted text-foreground-muted line-through",
}

export function StatusBadge({ status }: { status: TaskStatus }): React.ReactElement {
  const { t } = useLocale()
  return (
    <Badge variant="outline" className={cn("h-5.5 px-2 text-xs sm:h-5", STATUS_STYLE[status])}>
      {t(`tasks.status.${status}`)}
    </Badge>
  )
}

/** Signal bars: filled count encodes the priority; high and urgent fill gold. */
const LEVEL: Record<TaskPriority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

export function PriorityLabel({ priority }: { priority: TaskPriority }): React.ReactElement {
  const { t } = useLocale()
  const level = LEVEL[priority]
  if (level === 0) return <span className="text-foreground-muted">—</span>
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        priority === "urgent" ? "font-semibold text-foreground" : "text-foreground-secondary",
      )}
    >
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className={cn(
              "w-[3px] rounded-[1px]",
              bar > level
                ? "bg-surface-strong"
                : level >= 3
                  ? "bg-brand"
                  : "bg-foreground-secondary",
            )}
            style={{ height: 3 + bar * 2.5 }}
          />
        ))}
      </span>
      {t(`tasks.priority.${priority}`)}
    </span>
  )
}
