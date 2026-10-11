"use client"

import { useRouter } from "next/navigation"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import { useAnswerInvitation } from "@/features/users/hooks/use-users"
import { workspacePath } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { MyInvitation } from "@/lib/types"

/** Workspaces that invited you: accept to join (and open it), or decline. */
export function MyInvitations({ invitations }: { invitations: MyInvitation[] }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const router = useRouter()
  const answer = useAnswerInvitation()

  return (
    <section className="flex flex-col gap-3" data-testid="my-invitations">
      <div>
        <h2 className="font-display text-xl">{t("workspaces.invitationsTitle")}</h2>
        <p className="text-xs text-foreground-muted">{t("workspaces.invitationsHint")}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {invitations.map((invite) => {
          const busy = answer.isPending && answer.variables?.id === invite.id
          const reply = (accept: boolean) =>
            answer.mutate(
              { id: invite.id, accept },
              {
                onSuccess: ({ accountId }) => {
                  toastManager.add({
                    type: "success",
                    title: accept
                      ? t("workspaces.joined", { workspace: invite.account.name })
                      : t("workspaces.declined"),
                  })
                  if (accountId) router.push(workspacePath(accountId, "/dashboard"))
                },
                onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
              },
            )
          return (
            <li
              key={invite.id}
              className="flex flex-col gap-4 rounded-md border border-brand-border bg-brand-surface p-5"
            >
              <div className="min-w-0">
                <span className="font-display block truncate text-xl">{invite.account.name}</span>
                <span className="mt-1 block text-sm text-foreground-secondary">
                  {invite.invitedBy
                    ? t("workspaces.invitedAs", {
                        name: invite.invitedBy,
                        role: t(`roles.${invite.role}`),
                      })
                    : t("workspaces.invitedAsNoName", { role: t(`roles.${invite.role}`) })}
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => reply(true)}>
                  {t("workspaces.accept")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => reply(false)}>
                  {t("workspaces.decline")}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
