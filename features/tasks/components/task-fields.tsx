"use client"

import { CalendarDaysIcon, CheckIcon, XIcon } from "lucide-react"
import * as React from "react"
import { FormRow } from "@/components/shell/form-row"
import { DatePicker } from "@/components/ui/date-picker"
import { Input } from "@/components/ui/input"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@/components/ui/menu"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { TimePicker } from "@/components/ui/time-picker"
import { useMeetingOptions } from "@/features/calendar/hooks/use-meetings"
import { AssigneePicker } from "@/features/tasks/components/assignees"
import { PriorityLabel, StatusBadge } from "@/features/tasks/components/task-badges"
import { PRIORITIES, STATUSES } from "@/features/tasks/lib/task-meta"
import { MEMBER_STATUSES, type TaskInput } from "@/lib/api/tasks"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { TaskPriority, TaskStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

export const EMPTY_TASK: TaskInput = {
  title: "",
  description: "",
  status: "open",
  priority: "none",
  startDate: "",
  startTime: "",
  dueDate: "",
  dueTime: "",
  assigneeIds: [],
  meetingId: null,
}

export function TaskFields({
  value,
  onChange,
  showStatus = false,
  disabled: allDisabled = false,
  statusOnly = false,
  showRelated = false,
  autoFocusTitle = false,
}: {
  value: TaskInput
  onChange: (next: TaskInput) => void
  showStatus?: boolean
  disabled?: boolean
  /** Members: only the status can change; the meeting link is shown elsewhere. */
  statusOnly?: boolean
  /** The meeting chip — only on the task page, not inside a meeting. */
  showRelated?: boolean
  autoFocusTitle?: boolean
}): React.ReactElement {
  const { t, formatDate } = useLocale()
  const set = <K extends keyof TaskInput>(key: K, v: TaskInput[K]) =>
    onChange({ ...value, [key]: v })
  const disabled = allDisabled || statusOnly
  const statuses = statusOnly
    ? STATUSES.filter((s) => MEMBER_STATUSES.includes(s) || s === value.status)
    : STATUSES

  const dateProps = {
    placeholder: t("common.pickDate"),
    clearLabel: t("common.clear"),
    formatValue: (ymd: string) => formatDate(ymd),
    disabled,
  }

  return (
    <div className="flex flex-col gap-5">
      {showRelated && !statusOnly ? (
        <MeetingChip
          meetingId={value.meetingId ?? null}
          disabled={disabled}
          onChange={(meetingId) => set("meetingId", meetingId)}
        />
      ) : null}
      <FormRow label={t("tasks.form.title")} htmlFor="task-title">
        <Input
          id="task-title"
          value={value.title}
          disabled={disabled}
          autoFocus={autoFocusTitle}
          placeholder={t("tasks.form.titlePlaceholder")}
          onChange={(e) => set("title", e.target.value)}
        />
      </FormRow>

      <FormRow label={t("tasks.form.description")} htmlFor="task-description">
        <Textarea
          id="task-description"
          value={value.description}
          disabled={disabled}
          rows={4}
          placeholder={t("tasks.form.descriptionPlaceholder")}
          onChange={(e) => set("description", e.target.value)}
        />
      </FormRow>

      <div className="grid gap-5 sm:grid-cols-2">
        {showStatus ? (
          <FormRow label={t("tasks.form.status")}>
            <Select
              value={value.status}
              disabled={allDisabled}
              onValueChange={(v) => v && set("status", v as TaskStatus)}
            >
              <SelectTrigger>
                <StatusBadge status={value.status} />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem
                    key={s}
                    value={s}
                    disabled={statusOnly && !MEMBER_STATUSES.includes(s)}
                  >
                    {t(`tasks.status.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
        ) : null}
        <FormRow label={t("tasks.form.priority")}>
          <Select
            value={value.priority}
            disabled={disabled}
            onValueChange={(v) => v && set("priority", v as TaskPriority)}
          >
            <SelectTrigger>
              {value.priority === "none" ? (
                <span className="text-foreground-muted">{t("tasks.priority.none")}</span>
              ) : (
                <PriorityLabel priority={value.priority} />
              )}
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`tasks.priority.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
      </div>

      <div className="grid gap-5">
        <FormRow label={t("tasks.form.start")}>
          <div className="flex items-center gap-2">
            <DatePicker
              {...dateProps}
              className="flex-1"
              value={value.startDate}
              onChange={(v) =>
                onChange({ ...value, startDate: v, startTime: v ? value.startTime : "" })
              }
            />
            <TimePicker
              className="shrink-0"
              value={value.startTime}
              disabled={disabled || !value.startDate}
              aria-label={t("tasks.form.time")}
              minuteStep={15}
              onChange={(v) => set("startTime", v)}
            />
          </div>
        </FormRow>
        <FormRow label={t("tasks.form.due")}>
          <div className="flex items-center gap-2">
            <DatePicker
              {...dateProps}
              className="flex-1"
              value={value.dueDate}
              onChange={(v) => onChange({ ...value, dueDate: v, dueTime: v ? value.dueTime : "" })}
            />
            <TimePicker
              className="shrink-0"
              value={value.dueTime}
              disabled={disabled || !value.dueDate}
              aria-label={t("tasks.form.time")}
              minuteStep={15}
              onChange={(v) => set("dueTime", v)}
            />
          </div>
        </FormRow>
      </div>

      <FormRow label={t("tasks.form.assignees")}>
        <AssigneePicker
          value={value.assigneeIds}
          disabled={disabled}
          onChange={(ids) => set("assigneeIds", ids)}
        />
      </FormRow>
    </div>
  )
}

/**
 * Meeting chip at the top of the task form: dashed "Meeting" when unlinked;
 * the meeting's title once picked. Click to choose or change, × to unlink.
 */
function MeetingChip({
  meetingId,
  disabled,
  onChange,
}: {
  meetingId: string | null
  disabled: boolean
  onChange: (meetingId: string | null) => void
}): React.ReactElement {
  const { t, formatDate } = useLocale()
  const [open, setOpen] = React.useState(false)
  // Load the list when it's opened, or to show the title of a linked meeting.
  const options = useMeetingOptions(open || Boolean(meetingId))
  const selected = options.data?.find((m) => m.id === meetingId)
  const label = (m: { title: string; date: string }) => `${m.title} · ${formatDate(m.date)}`

  return (
    <div className="flex" data-testid="meeting-chip">
      <span
        className={cn(
          "inline-flex h-7 max-w-full items-center rounded-full border text-sm transition-colors",
          meetingId
            ? "border-brand-border bg-brand-surface text-brand-ink"
            : "border-dashed border-input text-foreground-secondary",
        )}
      >
        <Menu open={open} onOpenChange={setOpen}>
          <MenuTrigger
            disabled={disabled}
            className="inline-flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full ps-2.5 pe-2.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            aria-label={t("tasks.form.meeting")}
          >
            <CalendarDaysIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {meetingId
                ? selected
                  ? label(selected)
                  : t("tasks.form.meeting")
                : t("tasks.form.meeting")}
            </span>
          </MenuTrigger>
          <MenuPopup align="start" className="max-h-80 w-72">
            <MenuGroup>
              <MenuGroupLabel>{t("tasks.form.pickMeeting")}</MenuGroupLabel>
              {options.isPending ? (
                <div className="px-2 py-3 text-xs text-foreground-muted">…</div>
              ) : (options.data ?? []).length === 0 ? (
                <div className="px-2 py-3 text-xs text-foreground-muted">
                  {t("tasks.form.noMeetings")}
                </div>
              ) : (
                (options.data ?? []).map((m) => (
                  <MenuItem key={m.id} onClick={() => onChange(m.id)}>
                    <CheckIcon className={cn(m.id === meetingId ? "" : "invisible")} />
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                    <span className="shrink-0 text-xs text-foreground-muted">
                      {formatDate(m.date)}
                    </span>
                  </MenuItem>
                ))
              )}
            </MenuGroup>
          </MenuPopup>
        </Menu>
        {meetingId && !disabled ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t("tasks.form.unlinkMeeting")}
            className="-ms-1 me-1 grid size-5 cursor-pointer place-items-center rounded-full hover:bg-brand-surface-subtle"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  )
}
