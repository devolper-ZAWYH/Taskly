"use client"

import { PlusIcon } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { FormError, FormRow } from "@/components/shell/form-row"
import { PageHeader } from "@/components/shell/page-header"
import { PasswordInput } from "@/components/shell/password-input"
import { SearchInput } from "@/components/shell/search-input"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toastManager } from "@/components/ui/toast"
import { PlatformUserSheet } from "@/features/platform/components/platform-user-sheet"
import { useCreatePlatformUser, usePlatformUsers } from "@/features/platform/hooks/use-platform"
import { useLocale } from "@/lib/i18n/locale-provider"
import { useDebouncedValue } from "@/lib/use-debounced-value"
import { cn } from "@/lib/utils"

export function PlatformUsersPage(): React.ReactElement {
  const { t } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [search, setSearch] = React.useState("")
  const [createOpen, setCreateOpen] = React.useState(false)
  const users = usePlatformUsers(useDebouncedValue(search))
  const openId = searchParams.get("user")

  const setOpen = (id: string | null) =>
    router.replace(id ? `${pathname}?user=${id}` : pathname, { scroll: false })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("platform.eyebrow")}
        title={t("platform.users")}
        subtitle={t("platform.usersSubtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t("platform.newUser")}
          </Button>
        }
      />
      <SearchInput value={search} onChange={setSearch} placeholder={t("users.searchPlaceholder")} />

      <div className="overflow-x-auto border-t">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className="eyebrow">{t("users.columns.name")}</TableHead>
              <TableHead className="eyebrow hidden sm:table-cell">
                {t("platform.columns.workspaces")}
              </TableHead>
              <TableHead className="eyebrow w-28">{t("platform.columns.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isPending
              ? Array.from({ length: 4 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={3} className="h-14">
                      <Skeleton className="h-4 w-60" />
                    </TableCell>
                  </TableRow>
                ))
              : null}
            {users.data?.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="h-32 text-center text-sm text-foreground-muted">
                  {t("users.empty")}
                </TableCell>
              </TableRow>
            ) : null}
            {users.data?.map((user) => (
              <TableRow
                key={user.id}
                tabIndex={0}
                onClick={() => setOpen(user.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setOpen(user.id)
                }}
                className="cursor-pointer outline-none hover:bg-surface-muted focus-visible:bg-surface-muted"
              >
                <TableCell className="h-14">
                  <span className="flex items-center gap-3">
                    <UserAvatar name={user.name} src={user.avatarUrl} inactive={!user.active} />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "flex items-center gap-2 truncate font-medium",
                          !user.active && "text-foreground-muted",
                        )}
                      >
                        <span className="truncate">{user.name}</span>
                        {user.isOperator ? (
                          <Badge className="h-4.5 border-transparent bg-foreground px-1.5 text-[10px] text-background">
                            {t("roles.operator")}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-foreground-muted" dir="ltr">
                        {user.email}
                      </span>
                    </span>
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span className="flex flex-wrap gap-1">
                    {user.workspaces.length === 0 ? (
                      <span className="text-sm text-foreground-muted">—</span>
                    ) : (
                      user.workspaces.map((w) => (
                        <Badge
                          key={w.membershipId}
                          variant="outline"
                          className="h-5 border-foreground/25 px-2 text-xs"
                        >
                          {w.accountName}
                          <span className="text-foreground-muted">· {t(`roles.${w.role}`)}</span>
                        </Badge>
                      ))
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 text-sm">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        user.active ? "bg-foreground" : "bg-foreground-disabled",
                      )}
                    />
                    {user.active ? t("common.active") : t("common.inactive")}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <PlatformUserCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => setOpen(id)}
      />
      <PlatformUserSheet userId={openId} onClose={() => setOpen(null)} />
    </div>
  )
}

function PlatformUserCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        {open ? (
          <PlatformUserCreateForm
            onDone={(id) => {
              onOpenChange(false)
              if (id) onCreated(id)
            }}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  )
}

function PlatformUserCreateForm({ onDone }: { onDone: (id?: string) => void }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const createUser = useCreatePlatformUser()
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [isOperator, setIsOperator] = React.useState(false)

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        createUser.mutate(
          { name, email, password, isOperator },
          {
            onSuccess: (user) => {
              toastManager.add({
                type: "success",
                title: t("users.create.created", { name: user.name }),
              })
              onDone(user.id)
            },
          },
        )
      }}
    >
      <DialogHeader>
        <DialogTitle className="font-display text-xl">{t("platform.newUser")}</DialogTitle>
        <DialogDescription>{t("platform.newUserHint")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <FormRow label={t("users.form.name")} htmlFor="p-user-name">
            <Input
              id="p-user-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormRow>
          <FormRow label={t("users.form.email")} htmlFor="p-user-email">
            <Input
              id="p-user-email"
              type="email"
              dir="ltr"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormRow>
          <FormRow
            label={t("users.form.password")}
            htmlFor="p-user-password"
            hint={t("users.form.passwordHint")}
          >
            <PasswordInput id="p-user-password" value={password} onChange={setPassword} />
          </FormRow>
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-md border p-3">
            <span>
              <span className="block text-sm font-medium">{t("roles.operator")}</span>
              <span className="block text-xs text-foreground-muted">
                {t("platform.operatorHint")}
              </span>
            </span>
            <Switch checked={isOperator} onCheckedChange={setIsOperator} />
          </label>
          <FormError message={createUser.error ? errorMessage(createUser.error) : null} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={createUser.isPending}>
          {t("platform.createUser")}
        </Button>
      </DialogFooter>
    </form>
  )
}
