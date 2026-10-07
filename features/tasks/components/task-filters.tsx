"use client"

import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { usePeople } from "@/features/tasks/hooks/use-tasks"
import { PRIORITIES } from "@/features/tasks/lib/task-meta"
import { CLOSED_STATUSES } from "@/lib/permissions"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { DueFilter, TaskFilters, TaskPriority, TaskScope, TaskStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

const ANY = "any"
const OPEN_STATUSES: TaskStatus[] = ["open", "in_progress", "on_hold"]
const DUE_OPTIONS: DueFilter[] = ["overdue", "today", "week", "none"]

export function hasActiveFilters(filters: TaskFilters): boolean {
  return Boolean(filters.status || filters.priority || filters.assigneeId || filters.due)
}

/** One compact select in the filter bar; "any" means the filter is off. */
function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string
  value: T | undefined
  options: { value: T; label: string }[]
  onChange: (value: T | undefined) => void
  testId: string
}) {
  const { t } = useLocale()
  const selected = options.find((o) => o.value === value)
  return (
    <Select
      value={value ?? ANY}
      onValueChange={(v) => onChange(!v || v === ANY ? undefined : (v as T))}
    >
      <SelectTrigger
        data-testid={testId}
        size="sm"
        className={cn("w-auto min-w-0 gap-1.5", selected && "border-foreground")}
      >
        <span className="text-foreground-muted">{label}:</span>
        <span className="truncate">{selected ? selected.label : t("tasks.filters.any")}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{t("tasks.filters.any")}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Administrators' filter bar: status, priority, assignee, due date. */
export function TaskFilterBar({
  scope,
  value,
  onChange,
}: {
  scope: TaskScope
  value: TaskFilters
  onChange: (next: TaskFilters) => void
}): React.ReactElement {
  const { t } = useLocale()
  const { data: people = [] } = usePeople()
  const set = <K extends keyof TaskFilters>(key: K, v: TaskFilters[K]) =>
    onChange({ ...value, [key]: v })
  const statuses = scope === "completed" ? CLOSED_STATUSES : OPEN_STATUSES

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="task-filters">
      <FilterSelect<TaskStatus>
        testId="filter-status"
        label={t("tasks.form.status")}
        value={value.status}
        options={statuses.map((s) => ({ value: s, label: t(`tasks.status.${s}`) }))}
        onChange={(v) => set("status", v)}
      />
      <FilterSelect<TaskPriority>
        testId="filter-priority"
        label={t("tasks.form.priority")}
        value={value.priority}
        options={PRIORITIES.map((p) => ({ value: p, label: t(`tasks.priority.${p}`) }))}
        onChange={(v) => set("priority", v)}
      />
      <FilterSelect<string>
        testId="filter-assignee"
        label={t("tasks.columns.assignees")}
        value={value.assigneeId}
        options={[
          { value: "none", label: t("tasks.filters.unassigned") },
          ...people.map((p) => ({ value: p.id, label: p.name })),
        ]}
        onChange={(v) => set("assigneeId", v)}
      />
      <FilterSelect<DueFilter>
        testId="filter-due"
        label={t("tasks.columns.due")}
        value={value.due}
        options={DUE_OPTIONS.map((d) => ({ value: d, label: t(`tasks.filters.due.${d}`) }))}
        onChange={(v) => set("due", v)}
      />
      {hasActiveFilters(value) ? (
        <Button variant="ghost" size="sm" onClick={() => onChange({})}>
          <XIcon />
          {t("tasks.filters.clear")}
        </Button>
      ) : null}
    </div>
  )
}
