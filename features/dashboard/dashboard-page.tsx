"use client"

import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CalendarDaysIcon,
  CheckCheckIcon,
  MapPinIcon,
} from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { PageHeader } from "@/components/shell/page-header"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { useCurrentUser } from "@/features/auth/use-auth"
import { toDateKey } from "@/features/calendar/lib/calendar-utils"
import {
  GoogleEventGroup,
  GoogleTaskGroup,
  useGoogleToday,
} from "@/features/google/dashboard-google"
import { StatusBadge } from "@/features/tasks/components/task-badges"
import { formatTaskRef } from "@/features/tasks/lib/task-meta"
import { useWorkspace, useWorkspacePath } from "@/features/workspace/workspace-context"
import { getDashboard } from "@/lib/api/dashboard"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Dashboard, Meeting, PersonalTask, PersonLoad, Task } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Lives under the tasks cache key, so task and meeting changes refresh it. */
function useDashboard() {
  const { accountId } = useWorkspace()
  const today = toDateKey(new Date())
  return useQuery({
    queryKey: ["tasks", accountId, "dashboard", today],
    queryFn: () => getDashboard(accountId, today),
  })
}

function greetingKey(hour: number): "morning" | "afternoon" | "evening" {
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"
}

export function DashboardPage(): React.ReactElement {
  const { t, intl } = useLocale()
  const me = useCurrentUser()
  const { isAdmin, account } = useWorkspace()
  const dashboard = useDashboard()
  const now = new Date()
  const firstName = me.name.split(/\s+/)[0]

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={account.name}
        title={t(`dashboard.greeting.${greetingKey(now.getHours())}`, { name: firstName })}
        subtitle={new Intl.DateTimeFormat(intl, {
          weekday: "long",
          day: "numeric",
          month: "long",
        }).format(now)}
      />
      {dashboard.data ? (
        <DashboardBody data={dashboard.data} isAdmin={isAdmin} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-md" />
          ))}
        </div>
      )}
    </div>
  )
}

function DashboardBody({ data, isAdmin }: { data: Dashboard; isAdmin: boolean }) {
  const { t } = useLocale()
  const meetingsToday = data.meetings.filter((m) => m.date === data.today).length
  // The viewer's own Google items for today (empty unless they're connected).
  const google = useGoogleToday(data.today)
  return (
    <>
      {data.team ? (
        <section aria-label={t("dashboard.teamTitle")} className="flex flex-col gap-3">
          <h2 className="eyebrow">{t("dashboard.teamTitle")}</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label={t("dashboard.stats.teamOverdue")} value={data.team.overdue} alert />
            <StatTile label={t("dashboard.stats.unassigned")} value={data.team.unassigned} />
            <StatTile label={t("dashboard.stats.dueThisWeek")} value={data.team.dueThisWeek} />
            <StatTile
              label={t("dashboard.stats.completedThisWeek")}
              value={data.team.completedThisWeek}
              note={t("dashboard.stats.createdThisWeek", { n: data.team.createdThisWeek })}
            />
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={t("dashboard.stats.overdue")} value={data.mine.overdue.length} alert />
          <StatTile label={t("dashboard.stats.dueToday")} value={data.mine.dueToday.length} />
          <StatTile label={t("dashboard.stats.next7")} value={data.mine.upcoming.length} />
          <StatTile label={t("dashboard.stats.meetingsToday")} value={meetingsToday} />
        </div>
      )}

      {data.team ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card
            title={t("dashboard.peopleTitle")}
            hint={t("dashboard.peopleHint")}
            className="lg:col-span-2"
          >
            <PeopleLoad people={data.team.people} />
          </Card>
          <Card title={t("dashboard.unassignedTitle")} action={<ViewAll path="/tasks" />}>
            <TaskList
              tasks={data.team.unassignedTasks}
              today={data.today}
              empty={t("dashboard.noUnassigned")}
            />
          </Card>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title={isAdmin ? t("dashboard.myWorkTitle") : t("dashboard.myTasksTitle")}
          action={<ViewAll path="/tasks" />}
          className="lg:col-span-2"
        >
          <MyTasks data={data} googleTasks={google.tasks} />
        </Card>
        <Card title={t("dashboard.meetingsTitle")} action={<ViewAll path="/calendar" />}>
          <GoogleEventGroup events={google.events} today={data.today} />
          <MeetingList meetings={data.meetings} today={data.today} />
        </Card>
      </div>
    </>
  )
}

/** Stat tile: label, value; overdue-style tiles turn red with an icon when > 0. */
function StatTile({
  label,
  value,
  alert = false,
  note,
}: {
  label: string
  value: number
  alert?: boolean
  note?: string
}) {
  const warn = alert && value > 0
  return (
    <div
      className={cn(
        "rounded-md border p-4",
        warn ? "border-destructive/30 bg-destructive-bg" : "bg-surface",
      )}
      data-testid="stat-tile"
    >
      <p className="flex items-center gap-1.5 text-sm text-foreground-secondary">
        {warn ? <AlertTriangleIcon className="size-4 text-destructive" aria-hidden="true" /> : null}
        {label}
      </p>
      <p
        className={cn(
          "font-display mt-1 text-3xl font-extrabold",
          warn ? "text-destructive-foreground" : "text-foreground",
        )}
      >
        {value.toLocaleString()}
      </p>
      {note ? <p className="mt-0.5 text-xs text-foreground-muted">{note}</p> : null}
    </div>
  )
}

function Card({
  title,
  hint,
  action,
  className,
  children,
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-md border", className)}>
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-display text-base">{title}</h2>
          {hint ? <p className="mt-0.5 text-xs text-foreground-muted">{hint}</p> : null}
        </div>
        {action}
      </header>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  )
}

function ViewAll({ path }: { path: string }) {
  const { t } = useLocale()
  const wsPath = useWorkspacePath()
  return (
    <Link
      href={wsPath(path)}
      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-ink hover:underline"
    >
      {t("dashboard.viewAll")}
      <ArrowRightIcon className="rtl-flip size-3.5" />
    </Link>
  )
}

function MyTasks({ data, googleTasks }: { data: Dashboard; googleTasks: PersonalTask[] }) {
  const { t } = useLocale()
  const groups = [
    { key: "overdue", label: t("dashboard.groups.overdue"), tasks: data.mine.overdue },
    { key: "today", label: t("dashboard.groups.today"), tasks: data.mine.dueToday },
    { key: "next", label: t("dashboard.groups.next7"), tasks: data.mine.upcoming },
  ].filter((g) => g.tasks.length > 0)
  if (groups.length === 0 && googleTasks.length === 0) {
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-foreground-muted">
        <CheckCheckIcon className="size-4" />
        {t("dashboard.caughtUp")}
      </p>
    )
  }
  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <div key={group.key}>
          <p
            className={cn(
              "eyebrow border-b bg-surface-muted px-4 py-2",
              group.key === "overdue" && "text-destructive-foreground",
            )}
          >
            {group.label} · {group.tasks.length}
          </p>
          <TaskList tasks={group.tasks} today={data.today} />
        </div>
      ))}
      <GoogleTaskGroup tasks={googleTasks} today={data.today} />
    </div>
  )
}

function TaskList({ tasks, today, empty }: { tasks: Task[]; today: string; empty?: string }) {
  const { formatDate, t } = useLocale()
  const wsPath = useWorkspacePath()
  if (tasks.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-foreground-muted">{empty}</p>
  }
  return (
    <ul>
      {tasks.map((task) => {
        const late = task.dueDate !== "" && task.dueDate < today
        return (
          <li key={task.id} className="border-b last:border-b-0">
            <Link
              href={wsPath(`/tasks?task=${formatTaskRef(task.number)}`)}
              className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover"
              data-testid="dashboard-task"
            >
              <span className="w-11 shrink-0 font-mono text-xs text-foreground-muted">
                {formatTaskRef(task.number)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
              <span
                className={cn(
                  "hidden shrink-0 text-xs sm:inline",
                  late ? "font-medium text-destructive-foreground" : "text-foreground-muted",
                )}
              >
                {task.dueDate ? formatDate(task.dueDate, task.dueTime) : t("dashboard.noDue")}
              </span>
              <StatusBadge status={task.status} />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function MeetingList({ meetings, today }: { meetings: Meeting[]; today: string }) {
  const { t, intl } = useLocale()
  const wsPath = useWorkspacePath()
  const day = new Intl.DateTimeFormat(intl, { weekday: "short", day: "numeric", month: "short" })
  if (meetings.length === 0) {
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-foreground-muted">
        <CalendarDaysIcon className="size-4" />
        {t("dashboard.noMeetings")}
      </p>
    )
  }
  return (
    <ul>
      {meetings.map((m) => (
        <li key={m.id} className="border-b last:border-b-0">
          <Link
            href={wsPath(`/calendar?view=week&date=${m.date}&meeting=${m.id}`)}
            className="flex gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover"
          >
            <span className="w-20 shrink-0 text-xs leading-5">
              <span
                className={cn(
                  "block",
                  m.date === today ? "font-semibold" : "text-foreground-muted",
                )}
              >
                {m.date === today
                  ? t("dashboard.today")
                  : day.format(new Date(`${m.date}T00:00:00`))}
              </span>
              <span className="block text-foreground-muted tabular-nums" dir="ltr">
                {m.startTime}–{m.endTime}
              </span>
            </span>
            <span className="min-w-0">
              <span dir="auto" className="block truncate text-sm font-medium">
                {m.title}
              </span>
              {m.location ? (
                <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-foreground-muted">
                  <MapPinIcon className="size-3 shrink-0" />
                  <span className="truncate">{m.location}</span>
                </span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** One bar per person (open tasks), overdue count beside it in red with an icon. */
function PeopleLoad({ people }: { people: PersonLoad[] }) {
  const { t } = useLocale()
  const max = Math.max(1, ...people.map((p) => p.open))
  if (people.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-foreground-muted">
        {t("dashboard.noPeople")}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1 py-2" data-testid="people-load">
      {people.map(({ user, open, overdue }) => (
        <li
          key={user.id}
          className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 px-4 py-1.5"
          title={t("dashboard.personTitle", { name: user.name, open, overdue })}
        >
          <span className="flex min-w-0 items-center gap-2">
            <UserAvatar name={user.name} src={user.avatarUrl} size="sm" className="ring-0" />
            <span className="truncate text-sm">{user.name}</span>
          </span>
          <span className="h-2 rounded-full bg-brand-surface" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-brand"
              style={{ width: `${(open / max) * 100}%` }}
            />
          </span>
          <span className="flex w-24 items-center justify-end gap-2 text-sm tabular-nums">
            <span className="text-foreground">{t("dashboard.openCount", { n: open })}</span>
            {overdue > 0 ? (
              <span className="flex items-center gap-0.5 text-xs text-destructive-foreground">
                <AlertTriangleIcon className="size-3" aria-hidden="true" />
                {overdue}
                <span className="sr-only">{t("dashboard.groups.overdue")}</span>
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
