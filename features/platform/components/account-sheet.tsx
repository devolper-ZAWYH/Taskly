"use client"

import { ArrowUpRightIcon, Loader2Icon } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { FormError, FormRow } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import { LogoField } from "@/features/platform/components/logo-field"
import { AttachRow, MembershipRow } from "@/features/platform/components/membership-controls"
import {
  useAccount,
  useAccountMembers,
  useAttachUser,
  useDetachUser,
  usePlatformUsers,
  useSetMembershipRole,
  useUpdateAccount,
} from "@/features/platform/hooks/use-platform"
import { workspacePath } from "@/features/workspace/workspace-context"
import type { AccountSummary } from "@/lib/api/platform"
import { useLocale } from "@/lib/i18n/locale-provider"

export function AccountSheet({
  accountId,
  onClose,
}: {
  accountId: string | null
  onClose: () => void
}): React.ReactElement {
  const { t } = useLocale()
  const account = useAccount(accountId)
  return (
    <Sheet open={Boolean(accountId)} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup className="max-w-xl">
        {account.data ? (
          <AccountDetail key={account.data.id} account={account.data} />
        ) : account.isError ? (
          <SheetHeader>
            <SheetTitle>{t("errors.workspaceNotFound")}</SheetTitle>
          </SheetHeader>
        ) : (
          <div className="grid flex-1 place-items-center p-12">
            <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
          </div>
        )}
      </SheetPopup>
    </Sheet>
  )
}

function AccountDetail({ account }: { account: AccountSummary }): React.ReactElement {
  const { t, errorMessage, formatDateTime } = useLocale()
  const members = useAccountMembers(account.id)
  const users = usePlatformUsers("")
  const updateAccount = useUpdateAccount()
  const attach = useAttachUser()
  const setRole = useSetMembershipRole()
  const detach = useDetachUser()
  const [name, setName] = React.useState(account.name)

  const memberIds = new Set(members.data?.map((m) => m.id))
  const attachable = (users.data ?? [])
    .filter((u) => !memberIds.has(u.id) && !u.isOperator)
    .map((u) => ({ value: u.id, label: `${u.name} · ${u.email}` }))
  const error = updateAccount.error ?? attach.error ?? setRole.error ?? detach.error

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader>
        <span className="eyebrow pe-8">{t("platform.account")}</span>
        <SheetTitle className="font-display mt-1 text-xl leading-snug">{account.name}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{t("platform.createdOn", { date: formatDateTime(account.createdAt) })}</span>
          <Link
            href={workspacePath(account.id, "/dashboard")}
            className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2"
          >
            {t("platform.openWorkspace")}
            <ArrowUpRightIcon className="rtl-flip size-3.5" />
          </Link>
        </SheetDescription>
      </SheetHeader>

      <SheetPanel>
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-5">
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                updateAccount.mutate(
                  { id: account.id, input: { name } },
                  {
                    onSuccess: () =>
                      toastManager.add({ type: "success", title: t("platform.accountSaved") }),
                  },
                )
              }}
            >
              <FormRow
                label={t("platform.accountName")}
                htmlFor="edit-account-name"
                className="flex-1"
              >
                <Input
                  id="edit-account-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </FormRow>
              <Button
                type="submit"
                variant="outline"
                disabled={name.trim() === account.name || !name.trim()}
                loading={updateAccount.isPending}
              >
                {t("common.save")}
              </Button>
            </form>
            <LogoField account={account} />
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">{t("common.active")}</p>
                <p className="text-xs text-foreground-muted">{t("platform.accountActiveHint")}</p>
              </div>
              <Switch
                checked={account.active}
                onCheckedChange={(active) =>
                  updateAccount.mutate(
                    { id: account.id, input: { active } },
                    {
                      onSuccess: () =>
                        toastManager.add({ type: "success", title: t("platform.accountSaved") }),
                    },
                  )
                }
              />
            </div>
          </section>

          <section className="flex flex-col gap-3 border-t pt-6">
            <div>
              <h2 className="font-display text-xl">{t("platform.members")}</h2>
              <p className="text-xs text-foreground-muted">{t("platform.membersHint")}</p>
            </div>
            {members.data && members.data.length > 0 ? (
              <ul className="border-t">
                {members.data.map((m) => (
                  <MembershipRow
                    key={m.membershipId}
                    avatarName={m.name}
                    avatarSrc={m.avatarUrl}
                    title={m.name}
                    subtitle={m.email}
                    inactive={!m.active}
                    role={m.role}
                    disabled={setRole.isPending || detach.isPending}
                    onRoleChange={(role) => setRole.mutate({ membershipId: m.membershipId, role })}
                    onRemove={() => detach.mutateAsync(m.membershipId)}
                    removeTitle={t("platform.removeMemberTitle", {
                      name: m.name,
                      workspace: account.name,
                    })}
                    removeBody={t("platform.removeMemberBody", { name: m.name })}
                  />
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-foreground-muted">
                {t("platform.noMembers")}
              </p>
            )}
            <AttachRow
              options={attachable}
              placeholder={t("platform.pickUser")}
              emptyText={t("platform.allUsersAttached")}
              pending={attach.isPending}
              onAttach={(userId, role) =>
                attach.mutate(
                  { accountId: account.id, userId, role },
                  {
                    onSuccess: () =>
                      toastManager.add({ type: "success", title: t("platform.memberAdded") }),
                  },
                )
              }
            />
            <FormError message={error ? errorMessage(error) : null} />
          </section>
        </div>
      </SheetPanel>
    </div>
  )
}
