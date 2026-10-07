"use client"

import * as React from "react"
import { FormRow } from "@/components/shell/form-row"
import { DatePicker } from "@/components/ui/date-picker"
import { Input } from "@/components/ui/input"
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
  /** The "Related to" meeting picker — only on the task page, not inside a meeting. */
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

      {statusOnly || !showRelated ? null : (
        <RelatedTo
          meetingId={value.meetingId ?? null}
          disabled={disabled}
          onChange={(meetingId) => set("meetingId", meetingId)}
        />
      )}
    </div>
  )
}

/** "Related to": nothing, or one of the workspace's meetings. */
function RelatedTo({
  meetingId,
  disabled,
  onChange,
}: {
  meetingId: string | null
  disabled: boolean
  onChange: (meetingId: string | null) => void
}): React.ReactElement {
  const { t, formatDate } = useLocale()
  const [kind, setKind] = React.useState<"none" | "meeting">(meetingId ? "meeting" : "none")
  const options = useMeetingOptions(kind === "meeting")
  const selected = options.data?.find((m) => m.id === meetingId)
  const label = (m: { title: string; date: string }) => `${m.title} · ${formatDate(m.date)}`

  return (
    <div className="grid gap-5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      <FormRow label={t("tasks.form.relatedTo")}>
        <Select
          value={kind}
          disabled={disabled}
          onValueChange={(v) => {
            const next = v === "meeting" ? "meeting" : "none"
            setKind(next)
            if (next === "none") onChange(null)
          }}
        >
          <SelectTrigger data-testid="related-kind">
            {kind === "meeting" ? t("tasks.form.relatedMeeting") : t("tasks.form.relatedNone")}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("tasks.form.relatedNone")}</SelectItem>
            <SelectItem value="meeting">{t("tasks.form.relatedMeeting")}</SelectItem>
          </SelectContent>
        </Select>
      </FormRow>
      {kind === "meeting" ? (
        <FormRow label={t("tasks.form.meeting")}>
          <Select
            value={meetingId ?? ""}
            disabled={disabled || options.data?.length === 0}
            onValueChange={(v) => v && onChange(v)}
          >
            <SelectTrigger data-testid="related-meeting">
              {selected ? (
                <span className="truncate">{label(selected)}</span>
              ) : (
                <span className="text-foreground-muted">
                  {options.data?.length === 0
                    ? t("tasks.form.noMeetings")
                    : t("tasks.form.pickMeeting")}
                </span>
              )}
            </SelectTrigger>
            <SelectContent>
              {(options.data ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {label(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
      ) : null}
    </div>
  )
}
