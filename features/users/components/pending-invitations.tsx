"use client"

import { MailIcon, XIcon } from "lucide-react"
import * as React from "react"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import {
  useCancelInvitation,
  useInvitations,
  useResendInvitation,
} from "@/features/users/hooks/use-users"
import { useLocale } from "@/lib/i18n/locale-provider"

/**
 * People with a Taskly account who were invited to this workspace and haven't
 * answered yet. Hidden when there are none.
 */
export function PendingInvitations(): React.ReactElement | null {
  const { t, errorMessage, formatDateTime } = useLocale()
  const invitations = useInvitations()
  const resend = useResendInvitation()
  const cancel = useCancelInvitation()
  if (!invitations.data || invitations.data.length === 0) return null

  const failed = (error: Error) => toastManager.add({ type: "error", title: errorMessage(error) })

  return (
    <section className="flex flex-col gap-3" data-testid="pending-invitations">
      <div>
        <h2 className="font-display text-xl">{t("users.invitationsTitle")}</h2>
        <p className="text-xs text-foreground-muted">{t("users.invitationsHint")}</p>
      </div>
      <ul className="border-t">
        {invitations.data.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center gap-3 border-b py-2.5">
            <UserAvatar name={invite.name} src={invite.avatarUrl} size="sm" className="ring-0" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 truncate font-medium">
                <span className="truncate">{invite.name}</span>
                <Badge variant="outline" className="h-4.5 px-1.5 text-[10px]">
                  {t(`roles.${invite.role}`)}
                </Badge>
              </span>
              <span className="block truncate text-xs text-foreground-muted">
                <span dir="ltr">{invite.email}</span>
                {" · "}
                {invite.invitedBy
                  ? t("users.invitedBy", {
                      name: invite.invitedBy,
                      date: formatDateTime(invite.createdAt),
                    })
                  : t("users.invitedOn", { date: formatDateTime(invite.createdAt) })}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              loading={resend.isPending && resend.variables === invite.id}
              onClick={() =>
                resend.mutate(invite.id, {
                  onSuccess: () =>
                    toastManager.add({
                      type: "success",
                      title: t("users.reminderSent", { name: invite.name }),
                    }),
                  onError: failed,
                })
              }
            >
              <MailIcon />
              <span className="max-sm:sr-only">{t("users.resendReminder")}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive-foreground"
              loading={cancel.isPending && cancel.variables === invite.id}
              onClick={() =>
                cancel.mutate(invite.id, {
                  onSuccess: () =>
                    toastManager.add({
                      type: "success",
                      title: t("users.invitationCancelled", { name: invite.name }),
                    }),
                  onError: failed,
                })
              }
            >
              <XIcon />
              <span className="max-sm:sr-only">{t("users.cancelInvitation")}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
