"use client"

import { LanguagesIcon, Loader2Icon, PencilIcon, PrinterIcon, RotateCcwIcon } from "lucide-react"
import * as React from "react"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Button } from "@/components/ui/button"
import { useMinutesTranslation, useTranslationAvailable } from "@/features/minutes/hooks"
import { VISIBILITY_ICONS } from "@/features/minutes/minutes-editor"
import { printMinutes } from "@/features/minutes/print"
import { AssigneeStack } from "@/features/tasks/components/assignees"
import { useViewer } from "@/features/workspace/workspace-context"
import { canEditMinutes } from "@/lib/api/minutes"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { MeetingMinutes, PublicUser } from "@/lib/types"

/** Long minutes start folded to this many characters. */
const PREVIEW_CHARS = 600

/** Who wrote the minutes and who can read them, with the text below. */
export function MinutesCard({
  minutes,
  people,
  onEdit,
  header,
  collapsible = true,
}: {
  minutes: MeetingMinutes
  people: PublicUser[] | undefined
  onEdit: (minutes: MeetingMinutes) => void
  /** Shown above the author line (the meeting, on the Minutes page). */
  header?: React.ReactNode
  collapsible?: boolean
}): React.ReactElement {
  const { t, locale, dir, formatDate, formatDateTime } = useLocale()
  const me = useViewer()
  const [expanded, setExpanded] = React.useState(false)
  const [translating, setTranslating] = React.useState(false)
  const canTranslate = useTranslationAvailable().data === true
  const author = people?.find((p) => p.id === minutes.authorId)
  const mine = minutes.authorId === me.id
  const authorName = mine ? t("minutes.you") : (author?.name ?? t("minutes.formerMember"))
  const long = collapsible && minutes.body.length > PREVIEW_CHARS
  const body = long && !expanded ? `${minutes.body.slice(0, PREVIEW_CHARS).trimEnd()}…` : minutes.body
  const Icon = VISIBILITY_ICONS[minutes.visibility]

  function print() {
    printMinutes({
      heading: t("minutes.print.heading"),
      title: minutes.meetingTitle,
      meta: [
        formatDate(minutes.meetingDate),
        t("minutes.print.by", { name: author?.name ?? authorName }),
        t("minutes.updated", { when: formatDateTime(minutes.updatedAt) }),
      ].join(" · "),
      body: minutes.body,
      lang: locale,
      dir,
    })
  }

  return (
    <article className="flex flex-col gap-3 rounded-md border bg-card p-4" data-testid="minutes-card">
      {header}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <UserAvatar
            name={author?.name ?? "?"}
            src={author?.avatarUrl ?? null}
            inactive={author ? !author.active : true}
            size="sm"
            className="ring-0"
          />
          <span className="truncate">{authorName}</span>
        </span>
        <span
          className="inline-flex items-center gap-1 rounded-sm bg-surface-muted px-1.5 py-0.5 text-xs text-foreground-secondary"
          title={t(`minutes.visibilityHint.${minutes.visibility}`)}
        >
          <Icon className="size-3" aria-hidden="true" />
          {minutes.visibility === "people"
            ? t("minutes.badge.people", { count: minutes.sharedWithIds.length })
            : t(`minutes.badge.${minutes.visibility}`)}
        </span>
        {mine && minutes.visibility === "people" ? (
          <AssigneeStack ids={minutes.sharedWithIds} people={people} />
        ) : null}
        <span className="text-xs text-foreground-muted">
          {t("minutes.updated", { when: formatDateTime(minutes.updatedAt) })}
        </span>
        <span className="ms-auto flex gap-1">
          {canTranslate ? (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={translating}
              onClick={() => setTranslating((v) => !v)}
              data-testid="minutes-translate"
            >
              <LanguagesIcon />
              {translating ? t("minutes.translate.hide") : t("minutes.translate.action")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={print}
            aria-label={t("minutes.print.action")}
            title={t("minutes.print.action")}
          >
            <PrinterIcon />
          </Button>
          {canEditMinutes(me, minutes) ? (
            <Button size="sm" variant="outline" onClick={() => onEdit(minutes)}>
              <PencilIcon />
              {t("minutes.edit")}
            </Button>
          ) : null}
        </span>
      </div>
      {/* Each line takes its own direction: Arabic and English often share one set of minutes. */}
      <p
        dir="auto"
        className="text-start text-sm break-words whitespace-pre-wrap text-foreground-secondary [unicode-bidi:plaintext]"
      >
        {body}
      </p>
      {translating ? <MinutesTranslation minutes={minutes} /> : null}
      {long ? (
        <button
          type="button"
          className="cursor-pointer self-start text-sm font-medium underline underline-offset-2 hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t("minutes.showLess") : t("minutes.showMore")}
        </button>
      ) : null}
    </article>
  )
}

/** The minutes in the other language, translated on request (not stored). */
function MinutesTranslation({ minutes }: { minutes: MeetingMinutes }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const query = useMinutesTranslation(minutes, true)
  const translation = query.data
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed p-3" data-testid="minutes-translation">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium tracking-wide text-foreground-muted uppercase">
        <LanguagesIcon className="size-3" aria-hidden="true" />
        {translation
          ? `${t(`meetings.panel.translation.${translation.lang}`)} · ${t("meetings.panel.translation.machine")}`
          : t("minutes.translate.action")}
      </span>
      {translation ? (
        <p
          dir={translation.lang === "ar" ? "rtl" : "ltr"}
          lang={translation.lang}
          className="text-start text-sm break-words whitespace-pre-wrap text-foreground-secondary [unicode-bidi:plaintext]"
        >
          {translation.text}
        </p>
      ) : query.isError ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-destructive-foreground">
          {errorMessage(query.error)}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RotateCcwIcon />
            {t("meetings.panel.translation.retry")}
          </Button>
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          {t("meetings.panel.translation.pending")}
        </p>
      )}
    </div>
  )
}
