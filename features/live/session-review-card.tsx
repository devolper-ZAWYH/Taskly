"use client"

import { SparklesIcon } from "lucide-react"
import * as React from "react"
import { AppError } from "@/lib/api/core"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toastManager } from "@/components/ui/toast"
import {
  useLiveAccept,
  useLiveDiscard,
  useLiveDraftPoll,
  useLiveSessionOfMeeting,
  useLiveSummarize,
} from "@/features/live/hooks"
import { VISIBILITY_ICONS } from "@/features/minutes/minutes-editor"
import { usePeople } from "@/features/tasks/hooks/use-tasks"
import { useViewer } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import type {
  LiveDraft,
  LiveDraftActionItem,
  Meeting,
  MinutesVisibility,
  PublicUser,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The recorder's review of a finished live capture (docs/live-meetings.md §6):
 * the summary draft the summarizer made, edited on the spot (assignee and date
 * per action item, who reads the minutes, an optional note) and written at once
 * by "Accept" — minutes for the meeting and one task per action item. Discard
 * drops the draft without writing anything. The card only exists for the
 * person's own recording while its session is in review.
 */
export function SessionReviewCard({ meeting }: { meeting: Meeting }): React.ReactElement | null {
  const { t, errorMessage, formatDateTime } = useLocale()
  const session = useLiveSessionOfMeeting(meeting.id)

  const [expanded, setExpanded] = React.useState(false)
  // Bumped to re-fetch right away after a summarize (instead of waiting a tick).
  const [nudge, setNudge] = React.useState(0)
  const [finished, setFinished] = React.useState<"accept" | "discard" | null>(null)

  const reviewing = session?.status === "reviewing"
  const draft = useLiveDraftPoll(session, Boolean(reviewing && expanded && !finished), nudge)

  const summarize = useLiveSummarize()
  const accept = useLiveAccept()
  const discard = useLiveDiscard()

  // The card's choices, reset for every new draft (a regenerate replaced the row).
  const [overrides, setOverrides] = React.useState<Overrides>([])
  const [visibility, setVisibility] = React.useState<MinutesVisibility>("private")
  const [note, setNote] = React.useState("")
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)
  const draftId = draft?.id ?? null
  const [editingDraftId, setEditingDraftId] = React.useState<string | null>(null)
  if (draftId !== editingDraftId) {
    // Adjusting state during render (not an effect): the edits belong to one
    // draft, and a summary arriving is exactly the moment to start clean.
    setEditingDraftId(draftId)
    setOverrides([])
    setVisibility("private")
    setNote("")
  }

  if (!session || session.status !== "reviewing" || finished) return null

  const runSummarize = () => {
    summarize.mutate(session.id, {
      onSuccess: () => setNudge((n) => n + 1),
      onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
    })
  }

  const onAccept = () => {
    if (!draft) return
    accept.mutate(
      {
        sessionId: session.id,
        // The overrides are by item position: they belong to this draft only.
        draftId: draft.id,
        visibility,
        note: note.trim() || undefined,
        items: draft.actionItems.map((_, index) => overrides[index] ?? {}),
      },
      {
        onSuccess: (result) => {
          setFinished("accept")
          toastManager.add({
            type: "success",
            title: t(
              result.tasks.length > 0 ? "live.review.minuted" : "live.review.minutedNoTasks",
            ),
          })
        },
        onError: (error) => {
          toastManager.add({ type: "error", title: errorMessage(error) })
          if (error instanceof AppError && error.code === "liveDraftGone") setNudge((n) => n + 1)
        },
      },
    )
  }

  const onDiscard = async (): Promise<void> => {
    discard.mutate(session.id, {
      onSuccess: () => {
        setFinished("discard")
        toastManager.add({ type: "success", title: t("live.review.discarded") })
      },
      onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
    })
  }

  return (
    <details
      className="rounded-md border p-4"
      data-testid="live-review"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        {t("live.review.title")}
        <span className="text-xs font-normal text-foreground-muted">{t("live.review.subtitle")}</span>
      </summary>
      <div className="mt-4 flex flex-col gap-4">
        {draft ? (
          <DraftView
            draft={draft}
            overrides={overrides}
            setOverride={setOverride}
            visibility={visibility}
            setVisibility={setVisibility}
            note={note}
            setNote={setNote}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground-muted">{t("live.review.waiting")}</p>
            <div>
              <Button size="sm" variant="outline" loading={summarize.isPending} onClick={runSummarize}>
                <SparklesIcon />
                {summarize.isPending ? t("live.review.summarizing") : t("live.review.summarize")}
              </Button>
            </div>
          </div>
        )}
        {draft ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-foreground-muted" dir="auto">
              {t("live.review.expired", { time: formatDateTime(draft.expiresAt) })}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={accept.isPending}>
                {t("live.review.discard")}
              </Button>
              <Button loading={accept.isPending} onClick={onAccept}>
                {accept.isPending ? t("live.review.accepting") : t("live.review.accept")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t("live.review.discardTitle")}
        description={t("live.review.discardBody")}
        confirmLabel={t("live.review.discard")}
        onConfirm={onDiscard}
      />
    </details>
  )

  function setOverride(index: number, patch: { assigneeId?: string | null; due?: string | null }): void {
    // The list starts empty: write the slot, don't map over what isn't there.
    setOverrides((previous) => {
      const next = [...previous]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }
}

type Overrides = Array<{ assigneeId?: string | null; due?: string | null } | undefined>

/** The sections and the editable action items of one draft. */
function DraftView({
  draft,
  overrides,
  setOverride,
  visibility,
  setVisibility,
  note,
  setNote,
}: {
  draft: LiveDraft
  overrides: Overrides
  setOverride: (index: number, patch: { assigneeId?: string | null; due?: string | null }) => void
  visibility: MinutesVisibility
  setVisibility: (visibility: MinutesVisibility) => void
  note: string
  setNote: (note: string) => void
}): React.ReactElement {
  const { t } = useLocale()
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Section label={t("live.review.summaryLabel")}>
        <p dir="auto" className="text-sm whitespace-pre-wrap">
          {draft.sections.summary}
        </p>
      </Section>
      <Section label={t("live.review.decisionsLabel")}>
        {draft.sections.decisions.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {draft.sections.decisions.map((line, index) => (
              <li key={index} dir="auto" className="whitespace-pre-wrap">
                {line}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-foreground-muted">{t("live.review.decisionsEmpty")}</p>
        )}
      </Section>
      <Section label={t("live.review.followUpsLabel")}>
        {draft.sections.followUps.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {draft.sections.followUps.map((line, index) => (
              <li key={index} dir="auto" className="whitespace-pre-wrap">
                {line}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-foreground-muted">{t("live.review.followUpsEmpty")}</p>
        )}
      </Section>
      <Section label={t("live.review.itemsLabel")}>
        {draft.actionItems.length > 0 ? (
          <ul className="flex flex-col" data-testid="live-review-items">
            {draft.actionItems.map((item, index) => (
              <li key={index} className="flex flex-col gap-1.5 border-t py-3 first:border-t-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span dir="auto" className="min-w-0 text-sm font-medium">
                    {item.title}
                  </span>
                  {item.assignee ? (
                    <Badge variant="secondary" size="sm" className="max-w-40">
                      <span dir="auto" className="truncate">
                        {t("live.review.asHeard", { name: item.assignee })}
                      </span>
                    </Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <AssigneeChoice
                    item={item}
                    override={overrides[index]}
                    setAssignee={(assigneeId) => setOverride(index, { assigneeId })}
                  />
                  <DueChoice
                    item={item}
                    override={overrides[index]}
                    setDue={(due) => setOverride(index, { due })}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-foreground-muted">{t("live.review.itemsEmpty")}</p>
        )}
      </Section>
      <div className="grid gap-4 sm:grid-cols-1">
        <VisibilityChoice visibility={visibility} setVisibility={setVisibility} />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground-secondary">
            {t("live.review.note")}
          </span>
          <Textarea
            dir="auto"
            rows={2}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder={t("live.review.notePlaceholder")}
            data-testid="live-review-note"
          />
        </label>
      </div>
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground-secondary" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  )
}

/**
 * One action item's assignee. Until it is touched, "as heard" leaves the choice
 * to the server's match of the name the transcript said (never a guess: it
 * assigns only someone the reviewer may assign); picking a person is explicit.
 */
function AssigneeChoice({
  item,
  override,
  setAssignee,
}: {
  item: LiveDraftActionItem
  override: { assigneeId?: string | null; due?: string | null } | undefined
  setAssignee: (assigneeId: string | null | undefined) => void
}): React.ReactElement {
  const { t } = useLocale()
  const me = useViewer()
  const people = usePeople()
  const isAdmin = me.role === "administrator"
  const active = (people?.data ?? []).filter((person) => person.active)
  const options = isAdmin ? active : active.filter((person) => person.id === me.id)

  const value =
    override?.assigneeId === undefined
      ? "__heard__"
      : override.assigneeId === null
        ? "__none__"
        : override.assigneeId

  const chosen: PublicUser | undefined = options.find((person) => person.id === value)

  const label = ((): React.ReactNode => {
    if (value === "__heard__") {
      return (
        <span className="text-foreground-secondary" dir="auto">
          {item.assignee
            ? t("live.review.asHeard", { name: item.assignee })
            : t("live.review.assigneeNone")}
        </span>
      )
    }
    if (value === "__none__") {
      return <span className="text-foreground-muted">{t("live.review.assigneeNone")}</span>
    }
    return <span dir="auto">{chosen?.name ?? t("live.review.assigneeNone")}</span>
  })()

  return (
    <Select
      value={value}
      onValueChange={(next) =>
        setAssignee(next === "__heard__" ? undefined : next === "__none__" ? null : next)
      }
    >
      <SelectTrigger className="w-fit max-w-56">
        {label}
      </SelectTrigger>
      <SelectContent>
        {item.assignee ? (
          <SelectItem value="__heard__">
            <span dir="auto">{t("live.review.asHeard", { name: item.assignee })}</span>
          </SelectItem>
        ) : null}
        {options.map((person) => (
          <SelectItem key={person.id} value={person.id}>
            <span dir="auto">{person.id === me.id ? t("live.review.assigneeSelf") : person.name}</span>
          </SelectItem>
        ))}
        <SelectItem value="__none__">{t("live.review.assigneeNone")}</SelectItem>
      </SelectContent>
    </Select>
  )
}

/** One action item's due date: the draft's date until edited, clearable. */
function DueChoice({
  item,
  override,
  setDue,
}: {
  item: LiveDraftActionItem
  override: { assigneeId?: string | null; due?: string | null } | undefined
  setDue: (due: string | null) => void
}): React.ReactElement {
  const { t } = useLocale()
  const value =
    override?.due === undefined ? (item.due ?? "") : (override.due ?? "")
  return (
    <DatePicker
      className="w-fit"
      value={value}
      onChange={(next) => setDue(next ? next : null)}
      placeholder={t("live.review.dueNone")}
      aria-label={t("live.review.due")}
    />
  )
}

/** Who may read the minutes: private always; workspace is an administrator's call. */
function VisibilityChoice({
  visibility,
  setVisibility,
}: {
  visibility: MinutesVisibility
  setVisibility: (visibility: MinutesVisibility) => void
}): React.ReactElement {
  const { t } = useLocale()
  const me = useViewer()
  const isAdmin = me.role === "administrator"
  const options: { value: MinutesVisibility; label: string; hint?: string; disabled?: boolean }[] = [
    { value: "private", label: t("live.review.visibilityPrivate") },
    {
      value: "workspace",
      label: t("live.review.visibilityWorkspace"),
      hint: isAdmin ? undefined : t("live.review.visibilityHint"),
      disabled: !isAdmin,
    },
  ]
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground-secondary" aria-hidden="true">
        {t("live.review.visibility")}
      </span>
      <div className="flex flex-wrap items-center gap-1" data-testid="live-review-visibility">
        {options.map((option) => {
          const Icon = VISIBILITY_ICONS[option.value]
          const selected = visibility === option.value
          const strong = !option.disabled || selected
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={option.disabled}
              title={option.disabled ? option.hint : undefined}
              onClick={() => setVisibility(option.value)}
              className={cn(
                "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-[6px] px-3 text-sm transition-colors",
                option.disabled
                  ? "cursor-not-allowed text-foreground-muted"
                  : "cursor-pointer",
                strong && !selected && option.hint
                  ? "text-foreground-secondary"
                  : "",
                selected
                  ? "bg-foreground text-background"
                  : strong
                    ? "text-foreground-secondary hover:text-foreground"
                    : "",
              )}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{option.label}</span>
            </button>
          )
        })}
      </div>
      {isAdmin ? null : (
        <span className="text-xs text-foreground-muted">{t("live.review.visibilityHint")}</span>
      )}
    </label>
  )
}
