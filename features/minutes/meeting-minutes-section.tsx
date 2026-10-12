"use client"

import { NotebookPenIcon } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { useMeetingMinutes } from "@/features/minutes/hooks"
import { MinutesCard } from "@/features/minutes/minutes-card"
import { MinutesEditorDialog, type MinutesEditorState } from "@/features/minutes/minutes-editor"
import { useViewer } from "@/features/workspace/workspace-context"
import { canWriteMinutes } from "@/lib/api/minutes"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Meeting, PublicUser } from "@/lib/types"

/** The meeting panel's minutes: yours (write or edit), then others' shared with you. */
export function MeetingMinutesSection({
  meeting,
  people,
}: {
  meeting: Meeting
  people: PublicUser[] | undefined
}): React.ReactElement {
  const { t } = useLocale()
  const me = useViewer()
  const minutes = useMeetingMinutes(meeting.id)
  const [editor, setEditor] = React.useState<MinutesEditorState | null>(null)
  const list = minutes.data ?? []
  const hasMine = list.some((m) => m.authorId === me.id)

  return (
    <section className="flex flex-col gap-3 border-t pt-6" data-testid="meeting-minutes">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{t("minutes.panel.title")}</h2>
          <p className="text-xs text-foreground-muted">{t("minutes.panel.hint")}</p>
        </div>
        {!hasMine && minutes.isSuccess && canWriteMinutes(me, meeting) ? (
          <Button size="sm" onClick={() => setEditor({ mode: "create", meeting })}>
            <NotebookPenIcon />
            {t("minutes.panel.write")}
          </Button>
        ) : null}
      </div>
      {list.length > 0 ? (
        <div className="flex flex-col gap-3">
          {list.map((item) => (
            <MinutesCard
              key={item.id}
              minutes={item}
              people={people}
              onEdit={(m) => setEditor({ mode: "edit", minutes: m })}
            />
          ))}
        </div>
      ) : minutes.isSuccess ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-foreground-muted">
          {t("minutes.panel.empty")}
        </p>
      ) : null}
      <MinutesEditorDialog state={editor} onClose={() => setEditor(null)} />
    </section>
  )
}
