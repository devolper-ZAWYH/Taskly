"use client"

import { CheckIcon, CopyIcon } from "lucide-react"
import * as React from "react"
import { FormError, FormRow } from "@/components/shell/form-row"
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
import { toastManager } from "@/components/ui/toast"
import { RoleSelect } from "@/features/users/components/role-select"
import { useAddMember } from "@/features/users/hooks/use-users"
import type { AddMemberResult } from "@/lib/api/members"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Role } from "@/lib/types"

/** Add someone to the workspace: just their email and role. */
export function UserCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        {/* Mounted only while open so every opening starts blank. */}
        {open ? <UserCreateFlow onDone={() => onOpenChange(false)} /> : null}
      </DialogPopup>
    </Dialog>
  )
}

function UserCreateFlow({ onDone }: { onDone: () => void }): React.ReactElement {
  const [created, setCreated] = React.useState<AddMemberResult | null>(null)
  return created?.temporaryPassword ? (
    <NewAccountDetails result={created} onDone={onDone} />
  ) : (
    <UserCreateForm onAdded={setCreated} onDone={onDone} />
  )
}

function UserCreateForm({
  onAdded,
  onDone,
}: {
  onAdded: (result: AddMemberResult) => void
  onDone: () => void
}): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const addMember = useAddMember()
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<Role>("member")

  function submit(event: React.FormEvent) {
    event.preventDefault()
    addMember.mutate(
      { email, role },
      {
        onSuccess: (result) => {
          if (result.temporaryPassword) {
            onAdded(result)
            return
          }
          toastManager.add({
            type: "success",
            title: t("users.create.created", { name: result.member.name }),
          })
          onDone()
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle className="font-display text-xl">{t("users.create.title")}</DialogTitle>
        <DialogDescription>{t("users.create.description")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-5">
          <FormRow label={t("users.form.email")} htmlFor="new-user-email">
            <Input
              id="new-user-email"
              type="email"
              dir="ltr"
              autoComplete="off"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormRow>
          <FormRow label={t("users.form.role")}>
            <RoleSelect value={role} onChange={setRole} />
          </FormRow>
          <FormError message={addMember.error ? errorMessage(addMember.error) : null} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" loading={addMember.isPending} disabled={!email.trim()}>
          {t("users.create.submit")}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Shown once after a new account is created: the sign-in details to pass on. */
function NewAccountDetails({
  result,
  onDone,
}: {
  result: AddMemberResult
  onDone: () => void
}): React.ReactElement {
  const { t } = useLocale()
  const [copied, setCopied] = React.useState(false)
  const details = `${result.member.email}\n${result.temporaryPassword}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(details)
      setCopied(true)
    } catch {
      // Clipboard blocked: the details are still on screen to copy by hand.
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl">
          {t("users.create.accountCreated", { name: result.member.name })}
        </DialogTitle>
        <DialogDescription>{t("users.create.shareHint")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <dl className="grid gap-3 rounded-md border bg-surface-muted p-4 text-sm">
          <div>
            <dt className="eyebrow">{t("users.form.email")}</dt>
            <dd className="mt-1 font-mono" dir="ltr">
              {result.member.email}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">{t("users.create.temporaryPassword")}</dt>
            <dd
              className="mt-1 font-mono text-base select-all"
              dir="ltr"
              data-testid="temp-password"
            >
              {result.temporaryPassword}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-foreground-muted">{t("users.create.shownOnce")}</p>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t("users.create.copied") : t("users.create.copy")}
        </Button>
        <Button type="button" onClick={onDone}>
          {t("common.done")}
        </Button>
      </DialogFooter>
    </>
  )
}
