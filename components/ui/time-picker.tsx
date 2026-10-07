"use client"

import * as React from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"))
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"))

function splitTime(value: string): { hour: string; minute: string } {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return { hour: "", minute: "" }
  return { hour: match[1], minute: match[2] }
}

export type TimePickerProps = {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

export function TimePicker({
  id,
  value,
  onChange,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: TimePickerProps): React.ReactElement {
  const { hour, minute } = splitTime(value)

  function emit(nextHour: string, nextMinute: string) {
    if (!nextHour && !nextMinute) {
      onChange("")
      return
    }
    onChange(`${nextHour || "00"}:${nextMinute || "00"}`)
  }

  return (
    <div
      id={id}
      role="group"
      dir="ltr"
      aria-label={ariaLabel ?? "Time"}
      className={cn("flex min-w-0 items-center gap-1", className)}
    >
      <Select
        value={hour || undefined}
        disabled={disabled}
        onValueChange={(next) => {
          if (!next) {
            onChange("")
            return
          }
          emit(next, minute || "00")
        }}
      >
        <SelectTrigger size="sm" className="w-16 min-w-16 px-2">
          <SelectValue>{hour || "HH"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {HOURS.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {entry}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground" aria-hidden="true">
        :
      </span>
      <Select
        value={minute || undefined}
        disabled={disabled}
        onValueChange={(next) => {
          if (!next) {
            onChange("")
            return
          }
          emit(hour || "00", next)
        }}
      >
        <SelectTrigger size="sm" className="w-16 min-w-16 px-2">
          <SelectValue>{minute || "MM"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {MINUTES.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {entry}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
