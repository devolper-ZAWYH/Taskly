"use client"

import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { useLiveSessionOfMeeting, useLiveTranscriptPoll } from "@/features/live/hooks"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { LiveSegment, Locale, Meeting } from "@/lib/types"

/**
 * The meeting panel's read-only "Live transcript (beta)": what the recorder's
 * device hears while it records, and (after capture) what it heard. The
 * reader's own language leads; the spoken line
 * follows, dimmed like a machine translation, when it differs. The section
 * appears because the meeting has a session — among this person's recordings
 * — and stays invisible otherwise.
 */
export function LiveTranscriptSection({
  meeting,
}: {
  meeting: Meeting
}): React.ReactElement | null {
  const session = useLiveSessionOfMeeting(meeting.id)
  const segments = useLiveTranscriptPoll(session)
  const { t } = useLocale()
  const scroller = React.useRef<HTMLDivElement | null>(null)
  const [paused, setPaused] = React.useState(false)

  // Newest words stay in view unless the reader parked the scroll with a hover.
  React.useLayoutEffect(() => {
    if (!paused && scroller.current && segments.length > 0) {
      scroller.current.scrollTop = scroller.current.scrollHeight
    }
  }, [segments, paused])

  if (!session) return null
  const capturing = session.status === "capturing"

  return (
    <details className="rounded-md border p-4" data-testid="live-transcript">
      <summary className="flex flex-wrap cursor-pointer items-center gap-2 text-sm font-medium">
        {t("live.transcript.title")}
        {capturing ? (
          <Badge variant="success" size="sm" className="gap-1">
            <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
            {t("live.transcript.recording")}
          </Badge>
        ) : null}
        <span className="text-xs font-normal text-foreground-muted">
          {t("live.transcript.lines", { n: segments.length })}
        </span>
      </summary>
      <div
        ref={scroller}
        className="mt-3 max-h-72 overflow-y-auto pe-1"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {segments.length > 0 ? (
          <ul className="flex flex-col gap-2.5">
            {segments.slice(-200).map((segment) => (
              <SegmentRow key={segment.id} segment={segment} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-foreground-muted">
            {capturing ? t("live.transcript.waiting") : t("live.transcript.empty")}
          </p>
        )}
      </div>
    </details>
  )
}

/** "Me" (their microphone) or "Them" (the meeting app's own audio). */
function SpeakerChip({ source }: { source: LiveSegment["source"] }): React.ReactElement {
  const { t } = useLocale()
  return (
    <Badge variant="secondary" size="sm">
      {t(`live.transcript.${source === "mic" ? "me" : "them"}`)}
    </Badge>
  )
}

/**
 * The line in the reader's language: the device's translation into it, else
 * the spoken words when they were already in it, else whatever exists. An
 * Arabic reader gets `textAr`; an English reader gets `textEn`.
 */
function leadLine(segment: LiveSegment, locale: Locale): { text: string; lang: string | null } {
  const translated = locale === "ar" ? segment.textAr : segment.textEn
  if (translated) return { text: translated, lang: locale }
  if (segment.lang === locale) return { text: segment.text, lang: locale }
  const other = locale === "ar" ? segment.textEn : segment.textAr
  if (other) return { text: other, lang: locale === "ar" ? "en" : "ar" }
  return { text: segment.text, lang: segment.lang }
}

function SegmentRow({ segment }: { segment: LiveSegment }): React.ReactElement {
  const { t, locale } = useLocale()
  // The reader's language leads; the spoken line sits under it in translation grey.
  const lead = leadLine(segment, locale)
  const spokenDir = segment.lang === "ar" ? "rtl" : "auto"
  return (
    <li className="flex flex-col gap-0.5" data-testid="live-transcript-segment">
      <div className="flex items-center gap-2">
        <SpeakerChip source={segment.source} />
        <span className="text-xs text-foreground-muted">
          {`#${segment.seq}${segment.lang ? ` · ${segment.lang}` : ""}`}
        </span>
      </div>
      <p
        dir={lead.lang === "ar" ? "rtl" : "auto"}
        lang={lead.lang ?? undefined}
        className="text-sm whitespace-pre-wrap"
      >
        {lead.text}
      </p>
      {lead.text !== segment.text ? (
        <p
          dir={spokenDir}
          lang={segment.lang ?? undefined}
          className="text-xs whitespace-pre-wrap text-foreground-muted"
        >
          {/* An aria-label here would hide the words themselves from screen readers. */}
          <span className="sr-only">{`${t("live.transcript.original")}: `}</span>
          {segment.text}
        </p>
      ) : null}
    </li>
  )
}
