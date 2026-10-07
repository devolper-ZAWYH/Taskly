"use client"

import { PlusIcon, XIcon } from "lucide-react"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "@/components/ui/menu"
import { usePeople } from "@/features/tasks/hooks/use-tasks"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { PublicUser } from "@/lib/types"

export function AssigneeStack({
  ids,
  people,
}: {
  ids: string[]
  people: PublicUser[] | undefined
}): React.ReactElement {
  const users = ids
    .map((id) => people?.find((p) => p.id === id))
    .filter((u): u is PublicUser => Boolean(u))
  if (users.length === 0) return <span className="text-foreground-muted">—</span>
  return (
    <span className="flex items-center -space-x-1.5 rtl:space-x-reverse">
      {users.slice(0, 3).map((u) => (
        <UserAvatar key={u.id} name={u.name} src={u.avatarUrl} inactive={!u.active} size="sm" />
      ))}
      {users.length > 3 ? (
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-surface-strong text-[10px] font-medium ring-2 ring-background">
          +{users.length - 3}
        </span>
      ) : null}
    </span>
  )
}

export function AssigneePicker({
  value,
  onChange,
  disabled,
  addLabel,
}: {
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  /** Text on the add button; defaults to "Assign people". */
  addLabel?: string
}): React.ReactElement {
  const { t } = useLocale()
  const { data: people } = usePeople()
  const selected = value
    .map((id) => people?.find((p) => p.id === id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
  // Active people can be picked; already-assigned inactive people stay visible.
  const options = (people ?? []).filter((p) => p.active || value.includes(p.id))

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...value, id] : value.filter((v) => v !== id))
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((user) => (
        <span
          key={user.id}
          className="inline-flex h-7 items-center gap-1.5 rounded-sm border bg-card ps-1 pe-1.5 text-sm"
        >
          <UserAvatar
            name={user.name}
            src={user.avatarUrl}
            inactive={!user.active}
            size="sm"
            className="ring-0"
          />
          <span className={user.active ? "" : "text-foreground-muted"}>
            {user.name}
            {user.active ? "" : ` (${t("tasks.form.deactivated")})`}
          </span>
          {disabled ? null : (
            <button
              type="button"
              onClick={() => toggle(user.id, false)}
              className="cursor-pointer rounded-sm p-0.5 text-foreground-muted hover:bg-surface-hover hover:text-foreground"
              aria-label={`${t("common.delete")} ${user.name}`}
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </span>
      ))}
      {/* Read-only (e.g. members): show who's assigned, nothing to change. */}
      {disabled ? null : (
        <Menu>
          <MenuTrigger
            disabled={disabled}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-sm border border-dashed border-input px-2 text-sm text-foreground-secondary hover:border-foreground hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
            {addLabel ?? t("tasks.form.addAssignee")}
          </MenuTrigger>
          <MenuPopup align="start" className="w-60">
            {options.map((person) => (
              <MenuCheckboxItem
                key={person.id}
                checked={value.includes(person.id)}
                disabled={!person.active}
                closeOnClick={false}
                onCheckedChange={(checked) => toggle(person.id, checked)}
              >
                <span className="flex items-center gap-2">
                  <UserAvatar
                    name={person.name}
                    src={person.avatarUrl}
                    inactive={!person.active}
                    size="sm"
                    className="ring-0"
                  />
                  {person.name}
                </span>
              </MenuCheckboxItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
    </div>
  )
}
