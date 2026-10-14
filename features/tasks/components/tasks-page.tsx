"use client"

import { PlusIcon } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { ListPagination } from "@/components/shell/list-pagination"
import { PageHeader } from "@/components/shell/page-header"
import { SearchInput } from "@/components/shell/search-input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { useWorkspace } from "@/features/workspace/workspace-context"
import { toDateKey } from "@/features/calendar/lib/calendar-utils"
import { GoogleMark } from "@/features/google/google-mark"
import { useGoogleTasks } from "@/features/google/hooks"
import {
  PersonalTaskDialog,
  PersonalTaskList,
  type PersonalTaskDialogState,
} from "@/features/google/personal-tasks"
import { TaskCreateDialog } from "@/features/tasks/components/task-create-dialog"
import { hasActiveFilters, TaskFilterBar } from "@/features/tasks/components/task-filters"
import { TaskPanel } from "@/features/tasks/components/task-panel"
import { TasksTable } from "@/features/tasks/components/tasks-table"
import { TASKS_PAGE_SIZE, useTasks } from "@/features/tasks/hooks/use-tasks"
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
  const mine = scope === "mine"
  const [filters, setFilters] = React.useState<TaskFilters>({})
  const [search, setSearch] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [createOpen, setCreateOpen] = React.useState(false)
  const debouncedSearch = useDebouncedValue(search)

  // Mine also lists the viewer's own Google Tasks, under their private tasks.
  const googleTasks = useGoogleTasks()
  const [showCompleted, setShowCompleted] = React.useState(false)
  const [personalDialog, setPersonalDialog] = React.useState<PersonalTaskDialogState | null>(null)

  // "Overdue"/"today" follow the viewer's own calendar day.
  const activeFilters =
    isAdmin && filters.due ? { ...filters, today: toDateKey(new Date()) } : filters
  const tasks = useTasks(scope, debouncedSearch, page, isAdmin ? activeFilters : {})
  const openId = searchParams.get("task")

  function setTaskParam(id: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set("task", id)
    else params.delete("task")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  // Everyone has their private tasks and what's assigned to them; only
  // administrators see every workspace task.
  const tabs: TaskScope[] = isAdmin
    ? ["mine", "assigned", "all", "completed"]
    : ["mine", "assigned", "completed"]

  const filtered = Boolean(debouncedSearch) || hasActiveFilters(filters)
  const emptyText = filtered ? t("tasks.empty.search") : t(`tasks.empty.${scope}`)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("tasks.eyebrow")}
        title={t("tasks.title")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t("tasks.newTask")}
          </Button>
        }
      />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={scope}
          onValueChange={(value) => {
            if (value === scope) return
            setScope(value as TaskScope)
            // Status options differ per tab (open vs closed), so start that one fresh.
            setFilters((current) => ({ ...current, status: undefined }))
            setPage(1)
          }}
        >
          <TabsList variant="underline" className="gap-x-4">
            {tabs.map((tab) => (
              <TabsTab key={tab} value={tab} className="px-0">
                {t(`tasks.tabs.${tab}`)}
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

      {/* Your private tasks are all yours: nothing to filter by assignee. */}
      {isAdmin && !mine ? (
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
            onOpen={(task) => setTaskParam(task.id)}
          />
        </div>
        <ListPagination
          page={page}
          pageSize={TASKS_PAGE_SIZE}
          total={tasks.data?.total ?? 0}
          onPageChange={setPage}
        />
      </div>

      {mine && googleTasks ? (
        <section className="flex flex-col gap-3" data-testid="mine-google">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display flex items-center gap-2 text-xl">
                <GoogleMark />
                {t("tasks.mineGoogle.title")}
              </h2>
              <p className="text-xs text-foreground-muted">{t("tasks.mineGoogle.hint")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-secondary">
                <Switch checked={showCompleted} onCheckedChange={setShowCompleted} />
                {t("google.tasks.showCompleted")}
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPersonalDialog({ mode: "create" })}
              >
                <PlusIcon />
                {t("tasks.mineGoogle.add")}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto border-t">
            <PersonalTaskList
              showCompleted={showCompleted}
              onOpen={(task) => setPersonalDialog({ mode: "edit", task })}
            />
          </div>
        </section>
      ) : null}

      <TaskCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={{ private: mine }}
        privateChoice
        showRelated
      />
      <TaskPanel taskId={openId} onClose={() => setTaskParam(null)} />
      <PersonalTaskDialog state={personalDialog} onClose={() => setPersonalDialog(null)} />
    </div>
  )
}
