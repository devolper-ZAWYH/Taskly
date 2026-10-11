"use client"

import { MailIcon, Trash2Icon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError, FormRow } from "@/components/shell/form-row"
import { PasswordInput } from "@/components/shell/password-input"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import { useCurrentUser } from "@/features/auth/use-auth"
import { AttachRow, MembershipRow } from "@/features/platform/components/membership-controls"
import {
  useAccounts,
  useAttachUser,
  useDeletePlatformUser,
  useDetachUser,
  usePlatformUsers,
  useSetMembershipRole,
  useResendUserInvite,
  useSetPlatformUserPassword,
  useUpdatePlatformUser,
} from "@/features/platform/hooks/use-platform"
import type { UserSummary } from "@/lib/api/platform"
import { useLocale } from "@/lib/i18n/locale-provider"

export function PlatformUserSheet({
  userId,
  onClose,
}: {
  userId: string | null
  onClose: () => void
}): React.ReactElement {
  const users = usePlatformUsers("")
  const user = users.data?.find((u) => u.id === userId)
  return (
    <Sheet open={Boolean(userId)} onOpenChange={(open) => !open && onClose()}>
      <SheetPopup className="max-w-xl">
        {user ? <UserDetail key={user.id} user={user} onClose={onClose} /> : null}
      </SheetPopup>
    </Sheet>
  )
}

function UserDetail({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const { t, errorMessage } = useLocale()
  const me = useCurrentUser()
  const accounts = useAccounts("")
  const updateUser = useUpdatePlatformUser()
  const setPassword = useSetPlatformUserPassword()
  const attach = useAttachUser()
  const setRole = useSetMembershipRole()
  const detach = useDetachUser()
  const deleteUser = useDeletePlatformUser()
  const resendInvite = useResendUserInvite()
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const isSelf = me.id === user.id

  const [name, setName] = React.useState(user.name)
  const [email, setEmail] = React.useState(user.email)
  const [password, setPasswordValue] = React.useState("")
  const dirty = name !== user.name || email !== user.email

  const memberOf = new Set(user.workspaces.map((w) => w.accountId))
  const attachable = (accounts.data ?? [])
    .filter((a) => !memberOf.has(a.id))
    .map((a) => ({ value: a.id, label: a.active ? a.name : `${a.name} (${t("common.inactive")})` }))
  const membershipError = attach.error ?? setRole.error ?? detach.error

  const saved = () => toastManager.add({ type: "success", title: t("users.edit.saved") })

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        updateUser.mutate({ id: user.id, input: { name, email } }, { onSuccess: saved })
      }}
    >
      <SheetHeader>
        <div className="flex items-center gap-3 pe-8">
          <UserAvatar name={user.name} src={user.avatarUrl} inactive={!user.active} />
          <div className="min-w-0">
            <SheetTitle className="font-display truncate text-xl">{user.name}</SheetTitle>
            <SheetDescription className="truncate" dir="ltr">
              {user.email}
            </SheetDescription>
            {/* Their other confirmed addresses (they manage these in Settings). */}
            {user.otherEmails.length > 0 ? (
              <p className="truncate text-xs text-foreground-muted" dir="ltr">
                {user.otherEmails.join(" · ")}
              </p>
            ) : null}
          </div>
        </div>
      </SheetHeader>

      <SheetPanel>
        <div className="flex flex-col gap-8">
          <section className="flex flex-col gap-5">
            <h2 className="eyebrow">{t("users.form.details")}</h2>
            <FormRow label={t("users.form.name")} htmlFor="p-edit-name">
              <Input id="p-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
            </FormRow>
            <FormRow label={t("users.form.email")} htmlFor="p-edit-email">
              <Input
                id="p-edit-email"
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormRow>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">{t("users.form.active")}</p>
                <p className="text-xs text-foreground-muted">{t("platform.userActiveHint")}</p>
              </div>
              <Switch
                checked={user.active}
                disabled={isSelf}
                onCheckedChange={(active) =>
                  updateUser.mutate({ id: user.id, input: { active } }, { onSuccess: saved })
                }
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">{t("roles.operator")}</p>
                <p className="text-xs text-foreground-muted">{t("platform.operatorHint")}</p>
              </div>
              <Switch
                checked={user.isOperator}
                disabled={isSelf}
                onCheckedChange={(isOperator) =>
                  updateUser.mutate({ id: user.id, input: { isOperator } }, { onSuccess: saved })
                }
              />
            </div>
            <FormError message={updateUser.error ? errorMessage(updateUser.error) : null} />
          </section>

          <section className="flex flex-col gap-3 border-t pt-6">
            <div>
              <h2 className="font-display text-xl">{t("platform.workspaces")}</h2>
              <p className="text-xs text-foreground-muted">{t("platform.workspacesHint")}</p>
            </div>
            {user.workspaces.length > 0 ? (
              <ul className="border-t">
                {user.workspaces.map((w) => (
                  <MembershipRow
                    key={w.membershipId}
                    title={w.accountName}
                    role={w.role}
                    disabled={setRole.isPending || detach.isPending}
                    onRoleChange={(role) => setRole.mutate({ membershipId: w.membershipId, role })}
                    onRemove={() => detach.mutateAsync(w.membershipId)}
                    removeTitle={t("platform.removeMemberTitle", {
                      name: user.name,
                      workspace: w.accountName,
                    })}
                    removeBody={t("platform.removeMemberBody", { name: user.name })}
                  />
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-foreground-muted">
                {t("platform.noWorkspaces")}
              </p>
            )}
            <AttachRow
              options={attachable}
              placeholder={t("platform.pickWorkspace")}
              emptyText={t("platform.inAllWorkspaces")}
              pending={attach.isPending}
              onAttach={(accountId, role) =>
                attach.mutate(
                  { accountId, userId: user.id, role },
                  {
                    onSuccess: () =>
                      toastManager.add({ type: "success", title: t("platform.memberAdded") }),
                  },
                )
              }
            />
            <FormError message={membershipError ? errorMessage(membershipError) : null} />
          </section>

          <section className="flex flex-col gap-3 border-t pt-6">
            <div>
              <h2 className="eyebrow">{t("users.form.passwordSection")}</h2>
              <p className="mt-1 text-xs text-foreground-muted">
                {t("users.form.passwordSectionHint")}
              </p>
            </div>
            {user.invitePending ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3"
                data-testid="user-invite-pending"
              >
                <span className="text-sm">{t("platform.invitePendingHint")}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={resendInvite.isPending}
                  onClick={() =>
                    resendInvite.mutate(user.id, {
                      onSuccess: () =>
                        toastManager.add({
                          type: "success",
                          title: t("users.inviteResent", { email: user.email }),
                        }),
                      onError: (error) =>
                        toastManager.add({ type: "error", title: errorMessage(error) }),
                    })
                  }
                >
                  <MailIcon />
                  {t("users.resendInvite")}
                </Button>
              </div>
            ) : null}
            <FormRow label={t("users.form.newPassword")} htmlFor="p-edit-password">
              <PasswordInput id="p-edit-password" value={password} onChange={setPasswordValue} />
            </FormRow>
            <FormError message={setPassword.error ? errorMessage(setPassword.error) : null} />
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={!password}
                loading={setPassword.isPending}
                onClick={() =>
                  setPassword.mutate(
                    { id: user.id, password },
                    {
                      onSuccess: () => {
                        setPasswordValue("")
                        toastManager.add({ type: "success", title: t("users.edit.passwordSet") })
                      },
                    },
                  )
                }
              >
                {t("users.form.setPassword")}
              </Button>
            </div>
          </section>
        </div>
      </SheetPanel>

      <SheetFooter className="flex-wrap justify-between gap-2">
        <>
          {!isSelf ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive-foreground"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon />
              {t("platform.deleteUser")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.close")}
            </Button>
            <Button type="submit" disabled={!dirty} loading={updateUser.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </>
      </SheetFooter>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("platform.deleteUserTitle", { name: user.name })}
        description={t("platform.deleteUserBody")}
        confirmLabel={t("platform.deleteUser")}
        onConfirm={async () => {
          await deleteUser.mutateAsync(user.id)
          toastManager.add({
            type: "success",
            title: t("platform.userDeleted", { name: user.name }),
          })
          onClose()
        }}
      />
    </form>
  )
}
