/** Dates in the person's language, the way the Taskly app writes them. */
export function formats(locale: "en" | "ar") {
  // Western digits in Arabic too, as in the app (lib/i18n/locale-provider.tsx).
  const intl = locale === "ar" ? "ar-QA-u-nu-latn" : "en-GB"
  const at = (ymd: string) => new Date(`${ymd}T00:00:00Z`)
  const long = new Intl.DateTimeFormat(intl, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
  const short = new Intl.DateTimeFormat(intl, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
  return {
    /** "Tuesday 14 October" */
    longDate: (ymd: string) => long.format(at(ymd)),
    /** "Tue 14 Oct" */
    shortDate: (ymd: string) => short.format(at(ymd)),
    /** "15:00–16:00", kept left-to-right in Arabic text. */
    timeRange: (start: string, end: string) => `⁦${start}–${end}⁩`,
    time: (hhmm: string) => `⁦${hhmm}⁩`,
  }
}

export type Formats = ReturnType<typeof formats>

/** "2026-10-14 17:00" → date and time. */
export function splitDue(due: string | null): { date: string; time: string } | null {
  if (!due) return null
  const [date, time = ""] = due.split(" ")
  return { date, time }
}
