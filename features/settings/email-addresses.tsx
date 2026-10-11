"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckIcon, MailIcon, StarIcon, Trash2Icon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError, FormRow } from "@/components/shell/form-row"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { toastManager } from "@/components/ui/toast"
import { ME_KEY } from "@/features/auth/use-auth"
import {
  addMyEmail,
  listMyEmails,
  makeEmailPrimary,
  removeMyEmail,
  resendEmailConfirmation,
  setWorkspaceEmail,
} from "@/lib/api/emails"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { MyEmails } from "@/lib/types"

const EMAILS_KEY = ["my-emails"] as const

/** Settings → Email addresses: add, confirm, remove, make primary, and pick one per workspace. */
export function EmailAddresses(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const queryClient = useQueryClient()
  const emails = useQuery({ queryKey: EMAILS_KEY, queryFn: listMyEmails })
  const [draft, setDraft] = React.useState("")
  const [removing, setRemoving] = React.useState<string | null>(null)

  const onData = (data: MyEmails) => {
    queryClient.setQueryData(EMAILS_KEY, data)
    // Addresses show on member lists, and the primary is "me".
    void queryClient.invalidateQueries({ queryKey: ME_KEY })
    void queryClient.invalidateQueries({ queryKey: ["people"] })
    void queryClient.invalidateQueries({ queryKey: ["members"] })
  }
  const failed = (error: Error) => toastManager.add({ type: "error", title: errorMessage(error) })
  const done = (title: string) => toastManager.add({ type: "success", title })

  const add = useMutation({ mutationFn: addMyEmail })
  const resend = useMutation({ mutationFn: resendEmailConfirmation })
  const remove = useMutation({ mutationFn: removeMyEmail })
  const primary = useMutation({ mutationFn: makeEmailPrimary })
  const pick = useMutation({
    mutationFn: ({ accountId, email }: { accountId: string; email: string }) =>
      setWorkspaceEmail(accountId, email),
  })

  if (emails.isPending) return <Skeleton className="h-40 w-full rounded-md" />
  if (emails.isError) return <FormError message={errorMessage(emails.error)} />
  const data = emails.data
  const confirmed = [data.primary, ...data.others.filter((e) => e.confirmed).map((e) => e.email)]

  return (
    <div className="flex flex-col gap-6" data-testid="email-addresses">
      <ul className="overflow-hidden rounded-md border">
        <li className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
          <span dir="ltr" className="min-w-0 flex-1 truncate text-sm font-medium">
            {data.primary}
          </span>
          <Badge className="h-5 border-transparent bg-foreground px-2 text-xs text-background">
            {t("settings.emails.primary")}
          </Badge>
        </li>
        {data.others.map((item) => (
          <li
            key={item.email}
            className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span dir="ltr" className="block truncate text-sm font-medium">
                {item.email}
              </span>
              <span className="block text-xs text-foreground-muted">
                {item.confirmed ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <CheckIcon className="size-3" aria-hidden="true" />
                    {t("settings.emails.confirmed")}
                  </span>
                ) : (
                  t("settings.emails.unconfirmed")
                )}
                {item.workspaces.length > 0
                  ? ` · ${t("settings.emails.usedBy", { workspaces: item.workspaces.join(", ") })}`
                  : ""}
              </span>
            </span>
            {item.confirmed ? (
              <Button
                size="sm"
                variant="ghost"
                loading={primary.isPending && primary.variables === item.email}
                onClick={() =>
                  primary.mutate(item.email, {
                    onSuccess: (next) => {
                      onData(next)
                      done(t("settings.emails.madePrimary", { email: item.email }))
                    },
                    onError: failed,
                  })
                }
              >
                <StarIcon />
                <span className="max-sm:sr-only">{t("settings.emails.makePrimary")}</span>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                loading={resend.isPending && resend.variables === item.email}
                onClick={() =>
                  resend.mutate(item.email, {
                    onSuccess: () => done(t("settings.emails.resent", { email: item.email })),
                    onError: failed,
                  })
                }
              >
                <MailIcon />
                <span className="max-sm:sr-only">{t("settings.emails.resend")}</span>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive-foreground"
              aria-label={`${t("settings.emails.remove")} ${item.email}`}
              onClick={() => setRemoving(item.email)}
            >
              <Trash2Icon />
            </Button>
          </li>
        ))}
      </ul>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const email = draft.trim()
          add.mutate(email, {
            onSuccess: (next) => {
              onData(next)
              setDraft("")
              done(t("settings.emails.added", { email }))
            },
          })
        }}
      >
        <FormRow label={t("settings.emails.add")} htmlFor="add-email" className="flex-1">
          <Input
            id="add-email"
            type="email"
            dir="ltr"
            autoComplete="email"
            placeholder={t("settings.emails.placeholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </FormRow>
        <Button type="submit" variant="outline" loading={add.isPending} disabled={!draft.trim()}>
          {t("settings.emails.add")}
        </Button>
      </form>
      <FormError message={add.error ? errorMessage(add.error) : null} />

      {data.workspaces.length > 0 && confirmed.length > 1 ? (
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium">{t("settings.emails.perWorkspace")}</h3>
            <p className="text-xs text-foreground-muted">{t("settings.emails.perWorkspaceHint")}</p>
          </div>
          {data.workspaces.map((w) => (
            <div key={w.accountId} className="grid grid-cols-[1fr_minmax(0,14rem)] items-center gap-3">
              <span className="truncate text-sm">{w.name}</span>
              <Select
                value={w.email}
                disabled={pick.isPending}
                onValueChange={(email) =>
                  email &&
                  email !== w.email &&
                  pick.mutate(
                    { accountId: w.accountId, email },
                    {
                      onSuccess: (next) => {
                        onData(next)
                        done(t("settings.emails.workspaceSaved", { workspace: w.name, email }))
                      },
                      onError: failed,
                    },
                  )
                }
              >
                <SelectTrigger>
                  <span dir="ltr" className="truncate">
                    {w.email}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {confirmed.map((email) => (
                    <SelectItem key={email} value={email}>
                      <span dir="ltr">{email}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("settings.emails.removeTitle", { email: removing ?? "" })}
        description={t("settings.emails.removeBody")}
        confirmLabel={t("settings.emails.remove")}
        onConfirm={async () => {
          if (!removing) return
          onData(await remove.mutateAsync(removing))
          done(t("settings.emails.removed", { email: removing }))
        }}
      />
    </div>
  )
}
