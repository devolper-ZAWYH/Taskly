"use client"

import { LockIcon } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AssigneeStack } from "@/features/tasks/components/assignees"
import { PriorityLabel, StatusBadge } from "@/features/tasks/components/task-badges"
import { usePeople, useUpdateTask } from "@/features/tasks/hooks/use-tasks"
import { isOverdue, PRIORITIES, STATUSES } from "@/features/tasks/lib/task-meta"
import { useViewer } from "@/features/workspace/workspace-context"
import { canEditTask, MEMBER_STATUSES } from "@/lib/api/tasks"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Task, TaskPriority, TaskStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

const INLINE_TRIGGER =
  "h-auto min-h-0 w-auto min-w-0 border-none bg-transparent p-0 shadow-none before:hidden hover:opacity-70 sm:min-h-0 [&_[data-slot=select-icon]]:hidden"

function InlineStatus({ task }: { task: Task }): React.ReactElement {
  const { t } = useLocale()
  const update = useUpdateTask()
  // Members move workspace tasks along but can't cancel them.
  const memberOnly = !canEditTask(useViewer(), task)
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Select
        value={task.status}
        disabled={update.isPending}
        onValueChange={(v) =>
          v && update.mutate({ id: task.id, patch: { status: v as TaskStatus } })
        }
      >
        <SelectTrigger className={INLINE_TRIGGER}>
          <StatusBadge status={task.status} />
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map((s) => (
            <SelectItem key={s} value={s} disabled={memberOnly && !MEMBER_STATUSES.includes(s)}>
              {t(`tasks.status.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function InlinePriority({ task }: { task: Task }): React.ReactElement {
  const { t } = useLocale()
  const update = useUpdateTask()
  // Only administrators (or a private task's owner) change priority; members just see it.
  const editable = canEditTask(useViewer(), task)
  if (!editable) return <PriorityLabel priority={task.priority} />
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Select
        value={task.priority}
        disabled={update.isPending}
        onValueChange={(v) =>
          v && update.mutate({ id: task.id, patch: { priority: v as TaskPriority } })
        }
      >
        <SelectTrigger className={INLINE_TRIGGER}>
          <PriorityLabel priority={task.priority} />
        </SelectTrigger>
        <SelectContent>
          {PRIORITIES.map((p) => (
            <SelectItem key={p} value={p}>
              {t(`tasks.priority.${p}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function TasksTable({
  tasks,
  loading,
  onOpen,
  empty,
}: {
  tasks: Task[]
  loading: boolean
  onOpen: (task: Task) => void
  empty: string
}): React.ReactElement {
  const { t, formatDate } = useLocale()
  const { data: people } = usePeople()

  return (
    <Table className="table-fixed sm:min-w-[760px]">
      <TableHeader>
        <TableRow className="border-b border-border hover:bg-transparent">
          <TableHead className="eyebrow">{t("tasks.columns.title")}</TableHead>
          <TableHead className="eyebrow w-28 sm:w-36">{t("tasks.columns.status")}</TableHead>
          <TableHead className="eyebrow hidden w-32 sm:table-cell">
            {t("tasks.columns.priority")}
          </TableHead>
          <TableHead className="eyebrow hidden w-32 sm:table-cell">
            {t("tasks.columns.assignees")}
          </TableHead>
          <TableHead className="eyebrow hidden w-40 sm:table-cell">
            {t("tasks.columns.due")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading && tasks.length === 0
          ? Array.from({ length: 6 }, (_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 5 }, (__, j) => (
                  <TableCell key={j} className="h-13">
                    <Skeleton className="h-4 w-full max-w-40" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : null}
        {!loading && tasks.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={5} className="h-40 text-center text-sm text-foreground-muted">
              {empty}
            </TableCell>
          </TableRow>
        ) : null}
        {tasks.map((task) => {
          const overdue = isOverdue(task)
          return (
            <TableRow
              key={task.id}
              tabIndex={0}
              onClick={() => onOpen(task)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onOpen(task)
              }}
              className="cursor-pointer outline-none hover:bg-surface-muted focus-visible:bg-surface-muted"
            >
              <TableCell className="h-13 max-w-0">
                <span
                  className={cn(
                    "flex items-center gap-1.5 font-medium",
                    task.status === "cancelled" && "text-foreground-muted line-through",
                  )}
                >
                  {task.private ? (
                    <LockIcon
                      className="size-3.5 shrink-0 text-foreground-muted"
                      aria-label={t("tasks.privateBadge")}
                    />
                  ) : null}
                  <span className="truncate">{task.title}</span>
                </span>
                {/* Mobile: due date moves under the title (its column is hidden). */}
                {task.dueDate ? (
                  <span
                    className={cn(
                      "mt-0.5 block text-xs tabular-nums sm:hidden",
                      overdue
                        ? "font-semibold text-destructive-foreground"
                        : "text-foreground-muted",
                    )}
                  >
                    {formatDate(task.dueDate, task.dueTime)}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                <InlineStatus task={task} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <InlinePriority task={task} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <AssigneeStack ids={task.assigneeIds} people={people} />
              </TableCell>
              <TableCell
                className={cn(
                  "hidden text-sm tabular-nums sm:table-cell",
                  overdue
                    ? "font-semibold text-destructive-foreground"
                    : "text-foreground-secondary",
                )}
              >
                {task.dueDate ? formatDate(task.dueDate, task.dueTime) : "—"}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
