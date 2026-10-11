/**
 * Personal Google events placed on this browser's calendar days. Google sends
 * timed events as instants and all-day events as dates with an exclusive end;
 * the calendar works in local date keys and `HH:MM`.
 */
import { addDays, parseDateKey, toDateKey } from "@/features/calendar/lib/calendar-utils"
import type { PersonalEvent } from "@/lib/types"

export type EventSpan = {
  event: PersonalEvent
  /** First and last local day the event touches (inclusive). */
  startKey: string
  endKey: string
  /** Timed events: local wall-clock times ("24:00" when it ends at midnight). "" for all-day. */
  startTime: string
  endTime: string
  /** All-day events, and timed ones lasting a day or more, go in the all-day row. */
  allDayRow: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

const pad = (n: number): string => String(n).padStart(2, "0")

function wallClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function toEventSpan(event: PersonalEvent): EventSpan {
  if (event.allDay) {
    const startKey = event.start.slice(0, 10)
    const fallback = parseDateKey(startKey, new Date())
    // Google's all-day end is exclusive: an event on the 3rd ends on the 4th.
    const lastKey = toDateKey(addDays(parseDateKey(event.end.slice(0, 10), fallback), -1))
    return {
      event,
      startKey,
      endKey: lastKey < startKey ? startKey : lastKey,
      startTime: "",
      endTime: "",
      allDayRow: true,
    }
  }
  const start = new Date(event.start)
  const end = new Date(event.end)
  const startKey = toDateKey(start)
  // An event ending exactly at midnight doesn't touch the next day.
  const endKey = end > start ? toDateKey(new Date(end.getTime() - 1)) : startKey
  return {
    event,
    startKey,
    endKey,
    startTime: wallClock(start),
    endTime: toDateKey(end) !== endKey ? "24:00" : wallClock(end),
    allDayRow: end.getTime() - start.getTime() >= DAY_MS,
  }
}

export function toEventSpans(events: PersonalEvent[]): EventSpan[] {
  return events.map(toEventSpan)
}

export function spansOn(spans: EventSpan[], dayKey: string): EventSpan[] {
  return spans.filter((s) => s.startKey <= dayKey && dayKey <= s.endKey)
}

export function isMultiDay(span: EventSpan): boolean {
  return span.startKey !== span.endKey
}

/** The part of `dayKey` a timed event covers, or null when it's all day there. */
export function spanTimesOn(span: EventSpan, dayKey: string): { from: string; to: string } | null {
  if (span.event.allDay) return null
  const from = dayKey === span.startKey ? span.startTime : "00:00"
  const to = dayKey === span.endKey ? span.endTime : "24:00"
  return from === "00:00" && to === "24:00" ? null : { from, to }
}

/** Sorts a day's items: all-day first, then by start time. */
export function spanSortKey(span: EventSpan, dayKey: string): string {
  if (span.allDayRow) return ""
  return spanTimesOn(span, dayKey)?.from ?? ""
}
