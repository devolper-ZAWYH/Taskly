"use client"

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useLocale } from "@/lib/i18n/locale-provider"

export function ListPagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}): React.ReactElement | null {
  const { t } = useLocale()
  if (total === 0) return null
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="flex items-center justify-between gap-4 pt-4">
      <span className="text-xs text-foreground-muted tabular-nums">
        {t("common.showing", { from, to, total })}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeftIcon className="rtl-flip" />
          {t("common.previous")}
        </Button>
        <span className="px-2 text-xs text-foreground-secondary tabular-nums">
          {page} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          {t("common.next")}
          <ChevronRightIcon className="rtl-flip" />
        </Button>
      </div>
    </div>
  )
}
