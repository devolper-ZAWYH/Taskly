"use client"

import { PlusIcon, XIcon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { RoleSelect } from "@/features/users/components/role-select"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Role } from "@/lib/types"

/** One membership line: who/where, role select, remove (behind a warning modal). */
export function MembershipRow({
  title,
  subtitle,
  avatarName,
  avatarSrc,
  role,
  inactive,
  disabled,
  onRoleChange,
  onRemove,
  removeTitle,
  removeBody,
}: {
  title: string
  subtitle?: string
  avatarName?: string
  avatarSrc?: string | null
  role: Role
  inactive?: boolean
  disabled?: boolean
  onRoleChange: (role: Role) => void
  onRemove: () => Promise<unknown>
  /** Warning shown before removing, e.g. "Remove Omar from Acme?" */
  removeTitle: string
  removeBody: string
}): React.ReactElement {
  const { t } = useLocale()
  const [confirming, setConfirming] = React.useState(false)
  return (
    <li className="flex flex-wrap items-center gap-3 border-b py-2.5" data-testid="membership-row">
      {avatarName ? (
        <UserAvatar
          name={avatarName}
          src={avatarSrc}
          inactive={inactive}
          size="sm"
          className="ring-0"
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span
          className={
            inactive ? "block truncate text-foreground-muted" : "block truncate font-medium"
          }
        >
          {title}
        </span>
        {subtitle ? (
          <span className="block truncate text-xs text-foreground-muted" dir="ltr">
            {subtitle}
          </span>
        ) : null}
      </span>
      <div className="w-36">
        <RoleSelect value={role} disabled={disabled} onChange={onRoleChange} />
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("platform.remove")}
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        <XIcon />
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={removeTitle}
        description={removeBody}
        confirmLabel={t("platform.remove")}
        onConfirm={onRemove}
      />
    </li>
  )
}

/** Pick something (a user or an account) + a role, then attach. */
export function AttachRow({
  options,
  placeholder,
  emptyText,
  pending,
  onAttach,
}: {
  options: { value: string; label: string }[]
  placeholder: string
  emptyText: string
  pending?: boolean
  onAttach: (value: string, role: Role) => void
}): React.ReactElement {
  const { t } = useLocale()
  const [value, setValue] = React.useState<string>("")
  const [role, setRole] = React.useState<Role>("member")
  const selected = options.find((o) => o.value === value)

  if (options.length === 0) {
    return <p className="text-xs text-foreground-muted">{emptyText}</p>
  }

  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="attach-row">
      <div className="min-w-48 flex-1">
        <Select value={value || null} onValueChange={(v) => setValue((v as string) ?? "")}>
          <SelectTrigger>
            <span className={selected ? "truncate" : "truncate text-foreground-muted"}>
              {selected?.label ?? placeholder}
            </span>
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-36">
        <RoleSelect value={role} onChange={setRole} />
      </div>
      <Button
        variant="outline"
        disabled={!value}
        loading={pending}
        onClick={() => {
          onAttach(value, role)
          setValue("")
        }}
      >
        <PlusIcon />
        {t("platform.add")}
      </Button>
    </div>
  )
}
