"use client"

import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { AgendaView } from "@/features/calendar/components/agenda-view"
import {
  MeetingFormDialog,
  type MeetingFormState,
} from "@/features/calendar/components/meeting-form-dialog"
import { MeetingPanel } from "@/features/calendar/components/meeting-panel"
import { MobileMonthView } from "@/features/calendar/components/mobile-month-view"
import { MonthView } from "@/features/calendar/components/month-view"
import { WeekView } from "@/features/calendar/components/week-view"
import { useCalendarTasks, useMeetings } from "@/features/calendar/hooks/use-meetings"
import {
  getMonthGridDays,
  getViewRange,
  getWeekDays,
  parseDateKey,
  parseView,
  shiftDate,
  toDateKey,
  type CalendarView,
} from "@/features/calendar/lib/calendar-utils"
import { ME_KEY, useCurrentUser } from "@/features/auth/use-auth"
import { useWorkspace, useWorkspacePath } from "@/features/workspace/workspace-context"
import { formatTaskRef } from "@/features/tasks/lib/task-meta"
import { updateMe } from "@/lib/api/auth"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { CalendarPreference, Meeting, Task } from "@/lib/types"
import { useMediaQuery } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * The person's saved phone calendar mode. Switching updates the screen at
 * once and saves to their account in the background.
 */
function usePhoneCalendarMode(): {
  value: CalendarPreference
  set: (mode: CalendarPreference) => void
} {
  const me = useCurrentUser()
  const queryClient = useQueryClient()
  return {
    value: me.calendarView,
    set: (mode) => {
      if (mode === me.calendarView) return
      const previous = me
      queryClient.setQueryData(ME_KEY, { ...me, calendarView: mode })
      updateMe({ calendarView: mode })
        .then((user) => queryClient.setQueryData(ME_KEY, user))
        .catch(() => queryClient.setQueryData(ME_KEY, previous))
    },
  }
}

export function CalendarPage(): React.ReactElement {
  const { t, intl } = useLocale()
  const me = useCurrentUser()
  const { viaOperator, isAdmin } = useWorkspace()
  const wsPath = useWorkspacePath()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Phones always work a month at a time (as a grid or a list).
  const isPhone = useMediaQuery("(max-width: 639px)")
  const view: CalendarView = isPhone ? "month" : parseView(searchParams.get("view"))
  const phoneMode = usePhoneCalendarMode()
  const [pickedDay, setPickedDay] = React.useState<string | null>(null)
  const date = parseDateKey(searchParams.get("date"), new Date())
  const meetingId = searchParams.get("meeting")

  const [showTasks, setShowTasks] = React.useState(true)
  const [form, setForm] = React.useState<MeetingFormState | null>(null)

  const range = getViewRange(view, date)
  const meetings = useMeetings(range)
  const tasks = useCalendarTasks(range, showTasks)
  const visibleTasks = showTasks ? (tasks.data ?? []) : []

  function setParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  const go = (nextView: CalendarView, nextDate: Date) =>
    setParams({ view: nextView, date: toDateKey(nextDate) })

  const openMeeting = (meeting: Meeting) => setParams({ meeting: meeting.id })
  const openTask = (task: Task) => router.push(wsPath(`/tasks?task=${formatTaskRef(task.number)}`))

  function createAt(dateKey: string, hour = 9) {
    setForm({
      mode: "create",
      initial: {
        title: "",
        notes: "",
        location: "",
        date: dateKey,
        startTime: `${pad(hour)}:00`,
        endTime: `${pad(Math.min(hour + 1, 23))}:00`,
        // Operators viewing a workspace aren't members, so they can't attend by default.
        attendeeIds: viaOperator ? [] : [me.id],
      },
    })
  }

  const title =
    view === "month"
      ? new Intl.DateTimeFormat(intl, { month: "long", year: "numeric" }).format(date)
      : (() => {
          const days = getWeekDays(date)
          return new Intl.DateTimeFormat(intl, {
            day: "numeric",
            month: "short",
            year: "numeric",
          }).formatRange(days[0], days[6])
        })()

  const agendaDays =
    view === "month"
      ? getMonthGridDays(date).filter((d) => d.getMonth() === date.getMonth())
      : getWeekDays(date)

  // Phone grid: the picked day if it's in this month, else today, else the 1st.
  const monthKey = toDateKey(date).slice(0, 7)
  const todayKey = toDateKey(new Date())
  const selectedKey = pickedDay?.startsWith(monthKey)
    ? pickedDay
    : todayKey.startsWith(monthKey)
      ? todayKey
      : `${monthKey}-01`

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("calendar.eyebrow")}
        title={t("calendar.title")}
        actions={
          isAdmin ? (
            <Button
              onClick={() =>
                createAt(toDateKey(new Date()), Math.min(new Date().getHours() + 1, 19))
              }
            >
              <PlusIcon />
              {t("calendar.newMeeting")}
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => go(view, new Date())}>
            {t("calendar.today")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("calendar.previous")}
            onClick={() => go(view, shiftDate(view, date, -1))}
          >
            <ChevronLeftIcon className="rtl-flip" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("calendar.next")}
            onClick={() => go(view, shiftDate(view, date, 1))}
          >
            <ChevronRightIcon className="rtl-flip" />
          </Button>
          <h2 className="font-display ms-1 text-xl" data-testid="calendar-title">
            {title}
          </h2>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-secondary">
            <Switch checked={showTasks} onCheckedChange={setShowTasks} />
            {t("calendar.showTasks")}
          </label>
          <div className="hidden rounded-md border p-0.5 sm:inline-flex" role="group">
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => go(v, date)}
                className={cn(
                  "h-7 cursor-pointer rounded-[1px] px-3 text-sm transition-colors",
                  view === v
                    ? "bg-foreground text-background"
                    : "text-foreground-secondary hover:text-foreground",
                )}
              >
                {t(`calendar.${v}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="hidden sm:block">
        {view === "month" ? (
          <MonthView
            month={date}
            meetings={meetings.data ?? []}
            tasks={visibleTasks}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
            onCreateAt={isAdmin ? (key) => createAt(key) : undefined}
            onShowDay={(day) => go("week", day)}
          />
        ) : (
          <WeekView
            date={date}
            meetings={meetings.data ?? []}
            tasks={visibleTasks}
            showTasks={showTasks}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
            onCreateAt={isAdmin ? createAt : undefined}
          />
        )}
      </div>
      <div className="flex flex-col gap-4 sm:hidden">
        <div
          className="inline-flex self-start rounded-md border p-0.5"
          role="group"
          aria-label={t("calendar.viewLabel")}
          data-testid="phone-view-toggle"
        >
          {(["calendar", "list"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={phoneMode.value === mode}
              onClick={() => phoneMode.set(mode)}
              className={cn(
                "h-8 cursor-pointer rounded-[6px] px-4 text-sm transition-colors",
                phoneMode.value === mode
                  ? "bg-foreground text-background"
                  : "text-foreground-secondary hover:text-foreground",
              )}
            >
              {mode === "calendar" ? t("calendar.viewCalendar") : t("calendar.viewList")}
            </button>
          ))}
        </div>
        {phoneMode.value === "calendar" ? (
          <MobileMonthView
            month={date}
            selectedKey={selectedKey}
            meetings={meetings.data ?? []}
            tasks={visibleTasks}
            onSelect={(key) => {
              setPickedDay(key)
              // A dimmed day from the next/previous month: go to that month.
              if (!key.startsWith(monthKey)) go("month", parseDateKey(key, date))
            }}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
          />
        ) : (
          <AgendaView
            days={agendaDays}
            meetings={meetings.data ?? []}
            tasks={visibleTasks}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
          />
        )}
      </div>

      <MeetingPanel
        meetingId={meetingId}
        onClose={() => setParams({ meeting: null })}
        onEdit={(meeting) => setForm({ mode: "edit", meeting })}
        onOpenTask={openTask}
      />
      <MeetingFormDialog
        state={form}
        onClose={() => setForm(null)}
        onSaved={(meeting) => {
          setForm(null)
          setParams({ meeting: meeting.id, date: meeting.date })
        }}
      />
    </div>
  )
}
