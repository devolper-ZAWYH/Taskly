"use client"

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Role } from "@/lib/types"

const ROLES: Role[] = ["administrator", "member"]

export function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: Role
  onChange: (role: Role) => void
  disabled?: boolean
}): React.ReactElement {
  const { t } = useLocale()
  return (
    <Select value={value} disabled={disabled} onValueChange={(v) => v && onChange(v as Role)}>
      <SelectTrigger>
        <span>{t(`roles.${value}`)}</span>
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {t(`roles.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
