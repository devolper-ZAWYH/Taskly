"use client"

import { CalendarDaysIcon, Loader2Icon } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { ListPagination } from "@/components/shell/list-pagination"
import { PageHeader } from "@/components/shell/page-header"
import { SearchInput } from "@/components/shell/search-input"
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import { MINUTES_PAGE_SIZE, useMinutes, useMinutesList } from "@/features/minutes/hooks"
import { MinutesCard } from "@/features/minutes/minutes-card"
import { MinutesEditorDialog, type MinutesEditorState } from "@/features/minutes/minutes-editor"
import { usePeople } from "@/features/tasks/hooks/use-tasks"
import { useWorkspacePath } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import { MINUTES_SCOPES, type MeetingMinutes, type MinutesScope } from "@/lib/types"
import { useDebouncedValue } from "@/lib/use-debounced-value"

/** Every set of minutes you can read in this workspace; `?minutes=<id>` opens one. */
export function MinutesPage(): React.ReactElement {
  const { t } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [scope, setScope] = React.useState<MinutesScope>("all")
  const [search, setSearch] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [editor, setEditor] = React.useState<MinutesEditorState | null>(null)
  const debouncedSearch = useDebouncedValue(search)
  const list = useMinutesList(scope, debouncedSearch, page)
  const { data: people } = usePeople()
  const openId = searchParams.get("minutes")

  function setMinutesParam(id: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set("minutes", id)
    else params.delete("minutes")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const items = list.data?.items ?? []
  const edit = (minutes: MeetingMinutes) => setEditor({ mode: "edit", minutes })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("minutes.eyebrow")}
        title={t("minutes.title")}
        subtitle={t("minutes.subtitle")}
      />

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={scope}
          onValueChange={(value) => {
            setScope(value as MinutesScope)
            setPage(1)
          }}
        >
          <TabsList variant="underline" className="gap-x-4">
            {MINUTES_SCOPES.map((tab) => (
              <TabsTab key={tab} value={tab} className="px-0">
                {t(`minutes.tabs.${tab}`)}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          placeholder={t("minutes.searchPlaceholder")}
        />
      </div>

      <div>
        {list.isPending ? (
          <div className="grid place-items-center p-12">
            <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-10 text-center text-sm text-foreground-muted">
            {debouncedSearch ? t("minutes.empty.search") : t(`minutes.empty.${scope}`)}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((minutes) => (
              <MinutesCard
                key={minutes.id}
                minutes={minutes}
                people={people}
                onEdit={edit}
                header={<MeetingHeading minutes={minutes} />}
              />
            ))}
          </div>
        )}
        <ListPagination
          page={page}
          pageSize={MINUTES_PAGE_SIZE}
          total={list.data?.total ?? 0}
          onPageChange={setPage}
        />
      </div>

      <MinutesSheet
        id={openId}
        onClose={() => setMinutesParam(null)}
        onEdit={edit}
      />
      <MinutesEditorDialog state={editor} onClose={() => setEditor(null)} />
    </div>
  )
}

/** The meeting the minutes belong to, linking to it when the reader may open it. */
function MeetingHeading({ minutes }: { minutes: MeetingMinutes }): React.ReactElement {
  const { t, formatDate } = useLocale()
  const path = useWorkspacePath()
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b pb-3">
      <h2 className="font-display min-w-0 text-lg leading-snug" dir="auto">
        {minutes.meetingTitle}
      </h2>
      <span className="flex items-center gap-3 text-xs text-foreground-muted">
        {formatDate(minutes.meetingDate)}
        {minutes.meetingId && minutes.meetingVisible ? (
          <Link
            href={path(
              `/calendar?view=week&date=${minutes.meetingDate}&meeting=${minutes.meetingId}`,
            )}
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-foreground"
          >
            <CalendarDaysIcon className="size-3.5" aria-hidden="true" />
            {t("minutes.openMeeting")}
          </Link>
        ) : !minutes.meetingId ? (
          <span>{t("minutes.meetingDeleted")}</span>
        ) : null}
      </span>
    </div>
  )
}

/** One set of minutes on its own (from a notification link). */
function MinutesSheet({
  id,
  onClose,
  onEdit,
}: {
  id: string | null
  onClose: () => void
  onEdit: (minutes: MeetingMinutes) => void
}): React.ReactElement {
  const { t } = useLocale()
  const query = useMinutes(id)
  const { data: people } = usePeople()
  return (
    <Sheet open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup className="max-w-xl">
        {query.data ? (
          <>
            <SheetHeader>
              <span className="eyebrow pe-8">{t("minutes.print.heading")}</span>
              <SheetTitle className="sr-only">{query.data.meetingTitle}</SheetTitle>
            </SheetHeader>
            <SheetPanel>
              <MinutesCard
                minutes={query.data}
                people={people}
                collapsible={false}
                onEdit={(minutes) => {
                  onClose()
                  onEdit(minutes)
                }}
                header={<MeetingHeading minutes={query.data} />}
              />
            </SheetPanel>
          </>
        ) : query.isError ? (
          <SheetHeader>
            <SheetTitle className="font-display text-xl">{t("minutes.notFound")}</SheetTitle>
          </SheetHeader>
        ) : (
          <div className="grid flex-1 place-items-center p-12">
            <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
          </div>
        )}
      </SheetPopup>
    </Sheet>
  )
}
