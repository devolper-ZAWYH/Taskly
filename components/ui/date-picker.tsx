"use client"

import { CalendarIcon } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

function parseDateValue(value: string): Date | undefined {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  )
  return Number.isNaN(date.getTime()) ? undefined : date
}

function formatDateValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatDisplay(value: string): string {
  const date = parseDateValue(value)
  if (!date) return "Pick a date"
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export type DatePickerProps = {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  placeholder?: string
  clearLabel?: string
  formatValue?: (value: string) => string
  "aria-label"?: string
}

export function DatePicker({
  id,
  value,
  onChange,
  disabled = false,
  className,
  placeholder = "Pick a date",
  clearLabel = "Clear",
  formatValue = formatDisplay,
  "aria-label": ariaLabel,
}: DatePickerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const selected = parseDateValue(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={ariaLabel}
            className={cn(
              "h-8 w-full min-w-0 shrink justify-start gap-2 rounded-sm px-3 font-normal sm:h-8",
              !value && "text-muted-foreground",
              className
            )}
          />
        }
      >
        <CalendarIcon className="size-4 opacity-70" aria-hidden="true" />
        <span className="truncate">
          {value ? formatValue(value) : placeholder}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            onChange(date ? formatDateValue(date) : "")
            setOpen(false)
          }}
        />
        {value ? (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
            >
              {clearLabel}
            </Button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  )
}
