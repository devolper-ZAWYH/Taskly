"use client"

import { FormRow } from "@/components/shell/form-row"
import { GoogleMark } from "@/features/google/google-mark"
import { useLocale } from "@/lib/i18n/locale-provider"
import { cn } from "@/lib/utils"

export type Where = "workspace" | "personal"

/** "Where" choice in the new-meeting dialog: this workspace, or the person's own Google Calendar. */
export function WhereSwitch({
  value,
  workspaceName,
  onChange,
}: {
  value: Where
  workspaceName: string
  onChange: (where: Where) => void
}): React.ReactElement {
  const { t } = useLocale()
  const options: { value: Where; label: React.ReactNode }[] = [
    { value: "workspace", label: <span dir="auto">{workspaceName}</span> },
    {
      value: "personal",
      label: (
        <>
          <GoogleMark />
          {t("google.calendar.wherePersonal")}
        </>
      ),
    },
  ]
  return (
    <FormRow label={t("google.calendar.where")}>
      <div
        className="inline-flex max-w-full self-start rounded-md border p-0.5"
        role="group"
        aria-label={t("google.calendar.where")}
        data-testid="where-switch"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => value !== option.value && onChange(option.value)}
            className={cn(
              "inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 truncate rounded-[6px] px-3 text-sm transition-colors",
              value === option.value
                ? "bg-foreground text-background"
                : "text-foreground-secondary hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </FormRow>
  )
}
