"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { FormError, FormRow } from "@/components/shell/form-row"
import { PasswordInput } from "@/components/shell/password-input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AuthHeading, AuthShell } from "@/features/auth/auth-shell"
import { homePath, ME_KEY } from "@/features/auth/use-auth"
import {
  acceptInvite,
  getInvite,
  getPasswordReset,
  resetPassword,
} from "@/lib/api/password-links"
import { useLocale } from "@/lib/i18n/locale-provider"

const LINKS = {
  invite: { get: getInvite, set: acceptInvite },
  reset: { get: getPasswordReset, set: resetPassword },
}

/**
 * `/invite?token=…` and `/reset-password?token=…`: choose a password from a
 * one-time emailed link, then you're signed in.
 */
export function SetPasswordPage({ kind }: { kind: "invite" | "reset" }): React.ReactElement {
  const { t, errorMessage, setLocale } = useLocale()
  const router = useRouter()
  const queryClient = useQueryClient()
  const token = useSearchParams().get("token") ?? ""
  const holder = useQuery({
    queryKey: ["password-link", kind, token],
    queryFn: () => LINKS[kind].get(token),
    enabled: Boolean(token),
    retry: false,
  })
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [mismatch, setMismatch] = React.useState(false)
  const save = useMutation({
    mutationFn: () => LINKS[kind].set(token, password),
    onSuccess: (user) => {
      queryClient.clear()
      queryClient.setQueryData(ME_KEY, user)
      setLocale(user.locale)
      router.replace(homePath(user))
    },
  })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const differs = password !== confirm
    setMismatch(differs)
    if (!differs) save.mutate()
  }

  if (!token || holder.isError) {
    return (
      <AuthShell testId={`${kind}-page`}>
        <AuthHeading
          title={kind === "invite" ? t("invite.invalidTitle") : t("reset.invalidTitle")}
          subtitle={kind === "invite" ? t("invite.invalidBody") : t("reset.invalidBody")}
        />
        <div className="mt-8 flex flex-wrap gap-2">
          {kind === "reset" ? (
            <Button render={<Link href="/forgot-password" />}>{t("reset.requestNew")}</Button>
          ) : null}
          <Button variant="outline" render={<Link href="/login" />}>
            {t("invite.toLogin")}
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell testId={`${kind}-page`}>
      {holder.isPending ? (
        <Skeleton className="h-64 w-full rounded-md" />
      ) : (
        <>
          <AuthHeading
            eyebrow={kind === "invite" ? t("invite.eyebrow") : t("reset.eyebrow")}
            title={kind === "invite" ? t("invite.title") : t("reset.title")}
            subtitle={
              kind === "invite"
                ? t("invite.subtitle", { name: holder.data.name, email: holder.data.email })
                : t("reset.subtitle", { email: holder.data.email })
            }
          />
          <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
            {/* Lets password managers save the new password against the right account. */}
            <input type="email" autoComplete="username" value={holder.data.email} readOnly hidden />
            <FormRow label={t("invite.password")} htmlFor="new-password">
              <PasswordInput id="new-password" value={password} onChange={setPassword} />
            </FormRow>
            <FormRow label={t("invite.confirm")} htmlFor="confirm-password">
              <PasswordInput id="confirm-password" value={confirm} onChange={setConfirm} />
            </FormRow>
            <FormError
              message={
                mismatch ? t("invite.mismatch") : save.error ? errorMessage(save.error) : null
              }
            />
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={save.isPending}
              disabled={!password || !confirm}
            >
              {kind === "invite" ? t("invite.submit") : t("reset.submit")}
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  )
}
