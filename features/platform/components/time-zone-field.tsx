"use client"

import * as React from "react"
import { FormRow } from "@/components/shell/form-row"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { toastManager } from "@/components/ui/toast"
import { useUpdateAccount } from "@/features/platform/hooks/use-platform"
import type { AccountSummary } from "@/lib/api/platform"
import { useLocale } from "@/lib/i18n/locale-provider"

/** Every IANA zone this browser knows, plus UTC (which some leave out). */
function allZones(): string[] {
  const zones = Intl.supportedValuesOf("timeZone")
  return zones.includes("UTC") ? zones : ["UTC", ...zones]
}

/** "" stands for "no workspace zone": each organiser's own. */
const NONE = ""

/** The workspace's time zone for meeting times (and their Google Calendar copies). Saves on pick. */
export function TimeZoneField({ account }: { account: AccountSummary }): React.ReactElement {
  const { t } = useLocale()
  const update = useUpdateAccount()
  const zones = React.useMemo(() => allZones(), [])
  const value = account.timeZone ?? NONE

  return (
    <FormRow
      label={t("platform.timeZone")}
      htmlFor="account-time-zone"
      hint={t("platform.timeZoneHint")}
    >
      <Select
        value={value}
        disabled={update.isPending}
        onValueChange={(next) => {
          if (next === null || next === value) return
          update.mutate(
            { id: account.id, input: { timeZone: next || null } },
            {
              onSuccess: () =>
                toastManager.add({ type: "success", title: t("platform.timeZoneSaved") }),
            },
          )
        }}
      >
        <SelectTrigger id="account-time-zone" data-testid="account-time-zone">
          <span dir={value ? "ltr" : undefined} className="truncate">
            {value || t("platform.timeZoneNone")}
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t("platform.timeZoneNone")}</SelectItem>
          {zones.map((zone) => (
            <SelectItem key={zone} value={zone}>
              <span dir="ltr">{zone}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormRow>
  )
}
