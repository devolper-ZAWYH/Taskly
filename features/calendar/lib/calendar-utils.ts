/**
 * Calendar date helpers + timed-event overlap layout.
 * Ported from Corpus `features/calendar/components/appointment-calendar-utils.ts`.
 * Weeks start on Sunday (Gulf convention).
 */
import type { Meeting } from "@/lib/types"

export type CalendarView = "month" | "week"

export const START_HOUR = 8
export const END_HOUR = 20

const pad = (n: number): string => String(n).padStart(2, "0")

export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseDateKey(value: string | null, fallback: Date): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return startOfDay(fallback)
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d)
}

export function parseView(value: string | null): CalendarView {
  return value === "month" ? "month" : "week"
}

export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

export function addDays(value: Date, days: number): Date {
  const next = startOfDay(value)
  next.setDate(next.getDate() + days)
  return next
}

export function addMonths(value: Date, months: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + months, 1)
}

export function getWeekDays(date: Date): Date[] {
  const first = addDays(date, -date.getDay())
  return Array.from({ length: 7 }, (_, i) => addDays(first, i))
}

export function getMonthGridDays(month: Date): Date[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1)
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0)
  const days: Date[] = []
  for (
    let day = addDays(firstDay, -firstDay.getDay());
    day <= addDays(lastDay, 6 - lastDay.getDay());
    day = addDays(day, 1)
  ) {
    days.push(day)
  }
  return days
}

/** Inclusive `YYYY-MM-DD` range the given view displays. */
export function getViewRange(view: CalendarView, date: Date): { from: string; to: string } {
  const days = view === "month" ? getMonthGridDays(date) : getWeekDays(date)
  return { from: toDateKey(days[0]), to: toDateKey(days[days.length - 1]) }
}

export function shiftDate(view: CalendarView, date: Date, step: 1 | -1): Date {
  return view === "month" ? addMonths(date, step) : addDays(date, step * 7)
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

export type MeetingLayout = {
  meeting: Meeting
  /** Percentages of the visible day column. */
  top: number
  height: number
  left: number
  width: number
}

/** Position a day's meetings in the time grid; overlapping meetings share the width. */
export function layoutMeetings(meetings: Meeting[], dayKey: string): MeetingLayout[] {
  const gridStart = START_HOUR * 60
  const gridEnd = END_HOUR * 60
  const total = gridEnd - gridStart

  const items = meetings
    .filter((m) => m.date === dayKey)
    .map((meeting) => ({
      meeting,
      start: Math.max(minutes(meeting.startTime), gridStart),
      // Keep very short meetings clickable (min 20 minutes tall).
      end: Math.min(Math.max(minutes(meeting.endTime), minutes(meeting.startTime) + 20), gridEnd),
    }))
    .filter((item) => item.end > gridStart && item.start < gridEnd)
    .sort((a, b) => a.start - b.start || b.end - a.end)

  const columns: number[] = []
  const placed = items.map((item) => {
    let column = columns.findIndex((end) => end <= item.start)
    if (column === -1) {
      column = columns.length
      columns.push(item.end)
    } else {
      columns[column] = item.end
    }
    return { ...item, column }
  })

  return placed.map((item) => {
    const overlapping = placed.filter((o) => o.start < item.end && o.end > item.start)
    const columnCount = Math.max(...overlapping.map((o) => o.column + 1), 1)
    return {
      meeting: item.meeting,
      top: ((item.start - gridStart) / total) * 100,
      height: ((item.end - item.start) / total) * 100,
      left: (item.column / columnCount) * 100,
      width: (1 / columnCount) * 100,
    }
  })
}

export function currentTimePercentage(now: Date): number | null {
  const m = now.getHours() * 60 + now.getMinutes()
  if (m < START_HOUR * 60 || m > END_HOUR * 60) return null
  return ((m - START_HOUR * 60) / ((END_HOUR - START_HOUR) * 60)) * 100
}
