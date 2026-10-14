"use client"

import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { PageHeader } from "@/components/shell/page-header"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
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
import {
  useGoogleConnected,
  usePersonalEvents,
  usePreviewGoogleEventImport,
} from "@/features/google/hooks"
import {
  PersonalEventFormDialog,
  type PersonalEventFormState,
} from "@/features/google/personal-event-form"
import { PersonalEventPanel } from "@/features/google/personal-event-panel"
import { toEventSpan, toEventSpans, type EventSpan } from "@/features/google/personal-events"
import { useWorkspace, useWorkspacePath } from "@/features/workspace/workspace-context"
import { updateMe } from "@/lib/api/auth"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { CalendarPreference, Meeting, PersonalEvent, Task } from "@/lib/types"
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
  const { t, intl, errorMessage } = useLocale()
  const me = useCurrentUser()
  const { viaOperator, isAdmin, account } = useWorkspace()
  const previewImport = usePreviewGoogleEventImport()
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
  // Links from a meeting's Google copy: open straight into writing minutes or adding a task.
  const action = searchParams.get("action")
  const startWith = action === "minutes" || action === "task" ? action : null

  const [showTasks, setShowTasks] = React.useState(true)
  const [form, setForm] = React.useState<MeetingFormState | null>(null)

  // The viewer's own Google events: only theirs, only when connected and shown.
  const googleConnected = useGoogleConnected()
  const [showGoogle, setShowGoogle] = React.useState(true)
  const [eventPanel, setEventPanel] = React.useState<{ span: EventSpan; open: boolean } | null>(
    null,
  )
  const [eventForm, setEventForm] = React.useState<PersonalEventFormState | null>(null)

  const range = getViewRange(view, date)
  const meetings = useMeetings(range)
  const tasks = useCalendarTasks(range, showTasks)
  const visibleTasks = showTasks ? (tasks.data ?? []) : []
  const googleShown = googleConnected && showGoogle
  const personalEvents = usePersonalEvents(range, googleShown)
  const eventData = personalEvents.data
  const events = React.useMemo(
    () => (googleShown && eventData ? toEventSpans(eventData) : []),
    [googleShown, eventData],
  )

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
  const openTask = (task: Task) => router.push(wsPath(`/tasks?task=${task.id}`))
  const openEvent = (span: EventSpan) => setEventPanel({ span, open: true })

  /** After saving a personal event: make sure it's visible, then show it. */
  function showSavedEvent(event: PersonalEvent) {
    const span = toEventSpan(event)
    setForm(null)
    setEventForm(null)
    setShowGoogle(true)
    setParams({ date: span.startKey })
    setEventPanel({ span, open: true })
  }

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

  /** Members can't create meetings; when connected they add events to their own Google Calendar. */
  function createEventAt(dateKey: string, hour = 9) {
    setEventForm({
      mode: "create",
      initial: {
        title: "",
        description: "",
        location: "",
        date: dateKey,
        startTime: `${pad(hour)}:00`,
        endTime: `${pad(Math.min(hour + 1, 23))}:00`,
        allDay: false,
      },
    })
  }

  const canCreate = isAdmin || googleConnected
  const createAtSlot = isAdmin ? createAt : createEventAt
  const nextHour = () => Math.min(new Date().getHours() + 1, 19)

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
            <Button onClick={() => createAt(toDateKey(new Date()), nextHour())}>
              <PlusIcon />
              {t("calendar.newMeeting")}
            </Button>
          ) : googleConnected ? (
            <Button onClick={() => createEventAt(toDateKey(new Date()), nextHour())}>
              <PlusIcon />
              {t("google.calendar.newEvent")}
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-secondary">
            <Switch checked={showTasks} onCheckedChange={setShowTasks} />
            {t("calendar.showTasks")}
          </label>
          {googleConnected ? (
            <label
              className="flex cursor-pointer items-center gap-2 text-sm text-foreground-secondary"
              data-testid="google-events-toggle"
            >
              <Switch checked={showGoogle} onCheckedChange={setShowGoogle} />
              {t("google.calendar.showEvents")}
              {googleShown && personalEvents.isError ? (
                <span className="text-xs text-destructive-foreground">
                  {t("google.calendar.loadError")}
                </span>
              ) : null}
            </label>
          ) : null}
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
            events={events}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
            onOpenEvent={openEvent}
            onCreateAt={canCreate ? (key) => createAtSlot(key) : undefined}
            onShowDay={(day) => go("week", day)}
          />
        ) : (
          <WeekView
            date={date}
            meetings={meetings.data ?? []}
            tasks={visibleTasks}
            showTasks={showTasks}
            events={events}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
            onOpenEvent={openEvent}
            onCreateAt={canCreate ? createAtSlot : undefined}
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
            events={events}
            onSelect={(key) => {
              setPickedDay(key)
              // A dimmed day from the next/previous month: go to that month.
              if (!key.startsWith(monthKey)) go("month", parseDateKey(key, date))
            }}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
            onOpenEvent={openEvent}
          />
        ) : (
          <AgendaView
            days={agendaDays}
            meetings={meetings.data ?? []}
            tasks={visibleTasks}
            events={events}
            onOpenMeeting={openMeeting}
            onOpenTask={openTask}
            onOpenEvent={openEvent}
          />
        )}
      </div>

      <MeetingPanel
        meetingId={meetingId}
        onClose={() => setParams({ meeting: null, action: null })}
        startWith={startWith}
        onStarted={() => setParams({ action: null })}
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
        onSavedPersonal={showSavedEvent}
      />
      <PersonalEventPanel
        span={eventPanel?.span ?? null}
        open={eventPanel?.open ?? false}
        onClose={() => setEventPanel((p) => (p ? { ...p, open: false } : p))}
        onEdit={(span) => setEventForm({ mode: "edit", span })}
        addToWorkspace={
          isAdmin
            ? {
                allowed: true,
                workspaceName: account.name,
                pending: previewImport.isPending,
                onAdd: (span) => {
                  const source = { calendarId: span.event.calendarId, eventId: span.event.id }
                  previewImport.mutate(source, {
                    onSuccess: ({ meeting, unmatched }) => {
                      setEventPanel((p) => (p ? { ...p, open: false } : p))
                      setForm({ mode: "create", initial: meeting, fromGoogle: { ...source, unmatched } })
                    },
                    onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
                  })
                },
              }
            : { allowed: false, workspaceName: account.name }
        }
      />
      <PersonalEventFormDialog
        state={eventForm}
        onClose={() => setEventForm(null)}
        onSaved={showSavedEvent}
      />
    </div>
  )
}
