"use client"

import { PlusIcon } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { ListPagination } from "@/components/shell/list-pagination"
import { PageHeader } from "@/components/shell/page-header"
import { SearchInput } from "@/components/shell/search-input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { useWorkspace } from "@/features/workspace/workspace-context"
import { toDateKey } from "@/features/calendar/lib/calendar-utils"
import { TaskCreateDialog } from "@/features/tasks/components/task-create-dialog"
import { hasActiveFilters, TaskFilterBar } from "@/features/tasks/components/task-filters"
import { TaskPanel } from "@/features/tasks/components/task-panel"
import { TasksTable } from "@/features/tasks/components/tasks-table"
import { TASKS_PAGE_SIZE, useTasks } from "@/features/tasks/hooks/use-tasks"
import { formatTaskRef } from "@/features/tasks/lib/task-meta"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { TaskFilters, TaskScope } from "@/lib/types"
import { useDebouncedValue } from "@/lib/use-debounced-value"

export function TasksPage(): React.ReactElement {
  const { t } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isAdmin } = useWorkspace()

  // Administrators work from the whole list; members from what's assigned to them.
  const [scope, setScope] = React.useState<TaskScope>(isAdmin ? "all" : "assigned")
  const [filters, setFilters] = React.useState<TaskFilters>({})
  const [search, setSearch] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [createOpen, setCreateOpen] = React.useState(false)
  const debouncedSearch = useDebouncedValue(search)

  // "Overdue"/"today" follow the viewer's own calendar day.
  const activeFilters =
    isAdmin && filters.due ? { ...filters, today: toDateKey(new Date()) } : filters
  const tasks = useTasks(scope, debouncedSearch, page, isAdmin ? activeFilters : {})
  const openRef = searchParams.get("task")

  function setTaskParam(ref: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (ref) params.set("task", ref)
    else params.delete("task")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  // Members only see what's assigned to them; administrators see everything.
  const tabs: { value: TaskScope; label: string }[] = isAdmin
    ? [
        { value: "all", label: t("tasks.tabs.all") },
        { value: "completed", label: t("tasks.tabs.completed") },
      ]
    : [
        { value: "assigned", label: t("tasks.tabs.assigned") },
        { value: "completed", label: t("tasks.tabs.completed") },
      ]

  const filtered = Boolean(debouncedSearch) || hasActiveFilters(filters)
  const emptyText = filtered ? t("tasks.empty.search") : t(`tasks.empty.${scope}`)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("tasks.eyebrow")}
        title={t("tasks.title")}
        actions={
          isAdmin ? (
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              {t("tasks.newTask")}
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={scope}
          onValueChange={(value) => {
            setScope(value as TaskScope)
            // Status options differ per tab (open vs closed), so start that one fresh.
            setFilters((current) => ({ ...current, status: undefined }))
            setPage(1)
          }}
        >
          <TabsList variant="underline" className="gap-x-4">
            {tabs.map((tab) => (
              <TabsTab key={tab.value} value={tab.value} className="px-0">
                {tab.label}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          placeholder={t("tasks.searchPlaceholder")}
        />
      </div>

      {isAdmin ? (
        <TaskFilterBar
          scope={scope}
          value={filters}
          onChange={(next) => {
            setFilters(next)
            setPage(1)
          }}
        />
      ) : null}

      <div>
        <div className="overflow-x-auto border-t">
          <TasksTable
            tasks={tasks.data?.items ?? []}
            loading={tasks.isPending}
            empty={emptyText}
            onOpen={(task) => setTaskParam(formatTaskRef(task.number))}
          />
        </div>
        <ListPagination
          page={page}
          pageSize={TASKS_PAGE_SIZE}
          total={tasks.data?.total ?? 0}
          onPageChange={setPage}
        />
      </div>

      {isAdmin ? (
        <TaskCreateDialog open={createOpen} onOpenChange={setCreateOpen} showRelated />
      ) : null}
      <TaskPanel taskRef={openRef} onClose={() => setTaskParam(null)} />
    </div>
  )
}
