"use client"

import { MailIcon, PlusIcon, UserMinusIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { ListPagination } from "@/components/shell/list-pagination"
import { PageHeader } from "@/components/shell/page-header"
import { SearchInput } from "@/components/shell/search-input"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toastManager } from "@/components/ui/toast"
import { useCurrentUser } from "@/features/auth/use-auth"
import { useWorkspace, useWorkspacePath } from "@/features/workspace/workspace-context"
import { RoleSelect } from "@/features/users/components/role-select"
import { PendingInvitations } from "@/features/users/components/pending-invitations"
import { UserCreateDialog } from "@/features/users/components/user-create-dialog"
import {
  USERS_PAGE_SIZE,
  useRemoveMember,
  useResendInvite,
  useUpdateMember,
  useUsers,
} from "@/features/users/hooks/use-users"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Role, WorkspaceMember } from "@/lib/types"
import { useDebouncedValue } from "@/lib/use-debounced-value"

/**
 * Workspace members, for Administrators: who's here (name, email), their role,
 * and revoking access. Accounts themselves are managed by the platform operator.
 */
export function UsersPage(): React.ReactElement | null {
  const { t, errorMessage } = useLocale()
  const me = useCurrentUser()
  const router = useRouter()
  const { isAdmin, account } = useWorkspace()
  const wsPath = useWorkspacePath()
  const updateMember = useUpdateMember()
  const removeMember = useRemoveMember()
  const resendInvite = useResendInvite()

  const [search, setSearch] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [revoking, setRevoking] = React.useState<WorkspaceMember | null>(null)
  const debouncedSearch = useDebouncedValue(search)
  const users = useUsers(debouncedSearch, page)

  React.useEffect(() => {
    if (!isAdmin) router.replace(wsPath("/dashboard"))
  }, [isAdmin, router, wsPath])
  if (!isAdmin) return null

  const rows = users.data?.items ?? []

  function changeRole(member: WorkspaceMember, role: Role) {
    updateMember.mutate(
      { userId: member.id, input: { role } },
      {
        onSuccess: () =>
          toastManager.add({
            type: "success",
            title: t("users.roleChanged", { name: member.name, role: t(`roles.${role}`) }),
          }),
        onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
      },
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("users.eyebrow")}
        title={t("users.title")}
        subtitle={t("users.subtitle", { workspace: account.name })}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            {t("users.addUser")}
          </Button>
        }
      />

      <SearchInput
        value={search}
        onChange={(value) => {
          setSearch(value)
          setPage(1)
        }}
        placeholder={t("users.searchPlaceholder")}
      />

      <PendingInvitations />

      <div>
        <div className="overflow-x-auto border-t">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="border-b border-border hover:bg-transparent">
                <TableHead className="eyebrow">{t("users.columns.name")}</TableHead>
                <TableHead className="eyebrow hidden sm:table-cell">
                  {t("users.columns.email")}
                </TableHead>
                <TableHead className="eyebrow w-40 sm:w-48">{t("users.columns.role")}</TableHead>
                <TableHead className="w-12 sm:w-28">
                  <span className="sr-only">{t("users.revoke")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isPending
                ? Array.from({ length: 4 }, (_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 4 }, (__, j) => (
                        <TableCell key={j} className="h-14">
                          <Skeleton className="h-4 w-full max-w-40" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : null}
              {!users.isPending && rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="h-32 text-center text-sm text-foreground-muted">
                    {t("users.emptyMembers")}
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((member) => {
                const isMe = member.id === me.id
                return (
                  <TableRow key={member.id} className="hover:bg-transparent">
                    <TableCell className="h-14">
                      <span className="flex items-center gap-3">
                        <UserAvatar name={member.name} src={member.avatarUrl} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 truncate font-medium">
                            <span className="truncate">{member.name}</span>
                            {isMe ? (
                              <span className="text-xs font-normal text-foreground-muted">
                                ({t("common.you")})
                              </span>
                            ) : null}
                            {member.invitePending ? (
                              <Badge
                                variant="outline"
                                className="h-4.5 px-1.5 text-[10px]"
                                data-testid="invite-pending"
                              >
                                {t("users.invitePending")}
                              </Badge>
                            ) : null}
                          </span>
                          {/* Mobile: email moves under the name (its column is hidden). */}
                          <span className="block truncate text-xs text-foreground-muted sm:hidden">
                            <span dir="ltr">{member.email}</span>
                          </span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="hidden truncate text-foreground-secondary sm:table-cell">
                      <span dir="ltr">{member.email}</span>
                    </TableCell>
                    <TableCell>
                      {/* You can't demote yourself; another administrator can. */}
                      <RoleSelect
                        value={member.role}
                        disabled={isMe || updateMember.isPending}
                        onChange={(role) => role !== member.role && changeRole(member, role)}
                      />
                    </TableCell>
                    <TableCell className="text-end">
                      {member.invitePending ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${t("users.resendInvite")} ${member.name}`}
                          loading={resendInvite.isPending && resendInvite.variables === member.id}
                          onClick={() =>
                            resendInvite.mutate(member.id, {
                              onSuccess: () =>
                                toastManager.add({
                                  type: "success",
                                  title: t("users.inviteResent", { email: member.email }),
                                }),
                              onError: (error) =>
                                toastManager.add({ type: "error", title: errorMessage(error) }),
                            })
                          }
                        >
                          <MailIcon />
                          <span className="max-sm:sr-only">{t("users.resendInvite")}</span>
                        </Button>
                      ) : null}
                      {isMe ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive-foreground"
                          aria-label={`${t("users.revoke")} ${member.name}`}
                          onClick={() => setRevoking(member)}
                        >
                          <UserMinusIcon />
                          <span className="max-sm:sr-only">{t("users.revoke")}</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <ListPagination
          page={page}
          pageSize={USERS_PAGE_SIZE}
          total={users.data?.total ?? 0}
          onPageChange={setPage}
        />
      </div>

      <UserCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("users.revokeTitle", { name: revoking?.name ?? "" })}
        description={t("users.revokeBody", { name: revoking?.name ?? "", workspace: account.name })}
        confirmLabel={t("users.revoke")}
        onConfirm={async () => {
          if (!revoking) return
          await removeMember.mutateAsync(revoking.id)
          toastManager.add({ type: "success", title: t("users.revoked", { name: revoking.name }) })
        }}
      />
    </div>
  )
}
