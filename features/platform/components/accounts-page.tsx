"use client"

import { PlusIcon } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { FormError, FormRow } from "@/components/shell/form-row"
import { PageHeader } from "@/components/shell/page-header"
import { SearchInput } from "@/components/shell/search-input"
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
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toastManager } from "@/components/ui/toast"
import { AccountSheet } from "@/features/platform/components/account-sheet"
import { useAccounts, useCreateAccount } from "@/features/platform/hooks/use-platform"
import { useLocale } from "@/lib/i18n/locale-provider"
import { useDebouncedValue } from "@/lib/use-debounced-value"
import { cn } from "@/lib/utils"

export function AccountsPage(): React.ReactElement {
  const { t, formatDateTime } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [search, setSearch] = React.useState("")
  const [status, setStatus] = React.useState<"active" | "inactive">("active")
  const [createOpen, setCreateOpen] = React.useState(false)
  const accounts = useAccounts(useDebouncedValue(search))
  const all = accounts.data ?? []
  const counts = {
    active: all.filter((a) => a.active).length,
    inactive: all.filter((a) => !a.active).length,
  }
  const rows = accounts.data?.filter((a) => a.active === (status === "active"))
  const openId = searchParams.get("account")

  const setOpen = (id: string | null) =>
    router.replace(id ? `${pathname}?account=${id}` : pathname, { scroll: false })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("platform.eyebrow")}
        title={t("platform.accounts")}
        subtitle={t("platform.accountsSubtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t("platform.newAccount")}
          </Button>
        }
      />
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={status} onValueChange={(v) => setStatus(v as "active" | "inactive")}>
          <TabsList variant="underline" className="gap-x-4">
            {(["active", "inactive"] as const).map((value) => (
              <TabsTab key={value} value={value} className="px-0">
                {t(`common.${value}`)}
                <span className="ms-1.5 text-xs text-foreground-muted tabular-nums">
                  {accounts.data ? counts[value] : ""}
                </span>
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("platform.searchAccounts")}
        />
      </div>

      <div className="overflow-x-auto border-t">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              <TableHead className="eyebrow">{t("platform.columns.account")}</TableHead>
              <TableHead className="eyebrow w-28">{t("platform.columns.members")}</TableHead>
              <TableHead className="eyebrow hidden w-48 sm:table-cell">
                {t("platform.columns.created")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.isPending
              ? Array.from({ length: 3 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={3} className="h-14">
                      <Skeleton className="h-4 w-60" />
                    </TableCell>
                  </TableRow>
                ))
              : null}
            {rows?.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="h-32 text-center text-sm text-foreground-muted">
                  {search.trim()
                    ? t("platform.noAccounts")
                    : status === "active"
                      ? t("platform.noActiveAccounts")
                      : t("platform.noInactiveAccounts")}
                </TableCell>
              </TableRow>
            ) : null}
            {rows?.map((account) => (
              <TableRow
                key={account.id}
                tabIndex={0}
                onClick={() => setOpen(account.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setOpen(account.id)
                }}
                className="cursor-pointer outline-none hover:bg-surface-muted focus-visible:bg-surface-muted"
              >
                <TableCell className="h-14">
                  <span
                    className={cn(
                      "block truncate font-medium",
                      !account.active && "text-foreground-muted",
                    )}
                  >
                    {account.name}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">{account.memberCount}</TableCell>
                <TableCell className="hidden text-sm text-foreground-secondary sm:table-cell">
                  {formatDateTime(account.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AccountCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => setOpen(id)}
      />
      <AccountSheet accountId={openId} onClose={() => setOpen(null)} />
    </div>
  )
}

function AccountCreateDialog({
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
          <AccountCreateForm
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

function AccountCreateForm({ onDone }: { onDone: (id?: string) => void }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const createAccount = useCreateAccount()
  const [name, setName] = React.useState("")

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        createAccount.mutate(
          { name },
          {
            onSuccess: (account) => {
              toastManager.add({
                type: "success",
                title: t("platform.accountCreated", { name: account.name }),
              })
              onDone(account.id)
            },
          },
        )
      }}
    >
      <DialogHeader>
        <DialogTitle className="font-display text-xl">{t("platform.newAccount")}</DialogTitle>
        <DialogDescription>{t("platform.newAccountHint")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <FormRow label={t("platform.accountName")} htmlFor="account-name">
            <Input
              id="account-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormRow>
          <FormError message={createAccount.error ? errorMessage(createAccount.error) : null} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={createAccount.isPending} disabled={!name.trim()}>
          {t("platform.createAccount")}
        </Button>
      </DialogFooter>
    </form>
  )
}
