"use client"

import { UsersIcon } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { toastManager } from "@/components/ui/toast"
import { GoogleMark } from "@/features/google/google-mark"
import {
  useAddSuggestedGoogleEvents,
  useDismissGoogleEventSuggestion,
  useGoogleEventSuggestions,
} from "@/features/google/hooks"
import { useWorkspace } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { GoogleEventSuggestion } from "@/lib/types"

const keyOf = (s: GoogleEventSuggestion) => `${s.calendarId}\n${s.eventId}`

/**
 * Calendar page, administrators: "N Google meetings include people from this
 * workspace", then a list to add them (with minutes and action items) in one go,
 * or mark one as not a work meeting.
 */
export function GoogleEventSuggestions({ enabled }: { enabled: boolean }): React.ReactElement | null {
  const { t } = useLocale()
  const { account } = useWorkspace()
  const suggestions = useGoogleEventSuggestions(enabled)
  const [open, setOpen] = React.useState(false)
  const items = suggestions.data ?? []
  if (!enabled || items.length === 0) return null

  return (
    <>
      <div
        className="flex items-start gap-3 rounded-md border border-brand-border bg-brand-surface-subtle px-4 py-3 sm:items-center"
        data-testid="google-suggestions"
      >
        <UsersIcon className="mt-0.5 size-4 shrink-0 text-brand-ink sm:mt-0" aria-hidden="true" />
        {/* Phones: the message on its own lines, the button under it. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <p className="min-w-0 flex-1 text-sm">
            {t("google.suggestions.banner", { count: String(items.length), workspace: account.name })}
          </p>
          <div>
            <Button size="sm" onClick={() => setOpen(true)}>
              {t("google.suggestions.review")}
            </Button>
          </div>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-xl">
          {open ? <Review items={items} onDone={() => setOpen(false)} /> : null}
        </DialogPopup>
      </Dialog>
    </>
  )
}

function Review({ items, onDone }: { items: GoogleEventSuggestion[]; onDone: () => void }): React.ReactElement {
  const { t, errorMessage, formatDate } = useLocale()
  const { account } = useWorkspace()
  const add = useAddSuggestedGoogleEvents()
  const dismiss = useDismissGoogleEventSuggestion()
  // Everything starts ticked; unticked ones are left for later.
  const [off, setOff] = React.useState<Set<string>>(new Set())
  const chosen = items.filter((item) => !off.has(keyOf(item)))

  function toggle(item: GoogleEventSuggestion, on: boolean) {
    setOff((current) => {
      const next = new Set(current)
      if (on) next.delete(keyOf(item))
      else next.add(keyOf(item))
      return next
    })
  }

  function addChosen() {
    add.mutate(
      chosen.map(({ calendarId, eventId }) => ({ calendarId, eventId })),
      {
        onSuccess: ({ added, skipped }) => {
          toastManager.add({
            type: "success",
            title: t("google.suggestions.added", { count: String(added) }),
            description: skipped > 0 ? t("google.suggestions.skipped", { count: String(skipped) }) : undefined,
          })
          onDone()
        },
      },
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl">{t("google.suggestions.title")}</DialogTitle>
        <DialogDescription>{t("google.suggestions.description", { workspace: account.name })}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ul className="flex flex-col divide-y rounded-md border">
          {items.map((item) => {
            const id = `suggestion-${keyOf(item).replace(/\W/g, "-")}`
            return (
              <li key={keyOf(item)} className="flex items-start gap-3 p-3">
                <input
                  id={id}
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-(--brand)"
                  checked={!off.has(keyOf(item))}
                  onChange={(e) => toggle(item, e.target.checked)}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <label htmlFor={id} className="flex cursor-pointer flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                      <GoogleMark />
                      <span dir="auto" className="min-w-0 break-words">
                        {item.title || t("google.noTitle")}
                      </span>
                    </span>
                    <span className="text-xs text-foreground-muted">
                      {formatDate(item.date)} ·{" "}
                      <span dir="ltr">
                        {item.startTime}–{item.endTime}
                      </span>
                    </span>
                    <span className="text-xs text-foreground-secondary">
                      {item.people.join(", ")}
                      {item.outsiders > 0
                        ? ` ${t("google.suggestions.outsiders", { count: String(item.outsiders) })}`
                        : ""}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="self-start text-xs text-foreground-muted underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate({ calendarId: item.calendarId, eventId: item.eventId })}
                  >
                    {t("google.suggestions.notWork")}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
        {add.error ? <p className="mt-3 text-sm text-destructive">{errorMessage(add.error)}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button loading={add.isPending} disabled={chosen.length === 0} onClick={addChosen}>
          {chosen.length === items.length
            ? t("google.suggestions.addAll", { count: String(chosen.length) })
            : t("google.suggestions.addSelected", { count: String(chosen.length) })}
        </Button>
      </DialogFooter>
    </>
  )
}
