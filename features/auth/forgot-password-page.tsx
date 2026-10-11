"use client"

import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import * as React from "react"
import { FormError, FormRow } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AuthHeading, AuthShell } from "@/features/auth/auth-shell"
import { requestPasswordReset } from "@/lib/api/password-links"
import { useLocale } from "@/lib/i18n/locale-provider"

/** `/forgot-password`: ask for a reset link by email. */
export function ForgotPasswordPage(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const [email, setEmail] = React.useState("")
  const request = useMutation({ mutationFn: () => requestPasswordReset(email.trim()) })

  return (
    <AuthShell testId="forgot-page">
      {request.isSuccess ? (
        <>
          <AuthHeading
            title={t("forgot.sentTitle")}
            subtitle={t("forgot.sentBody", { email: email.trim() })}
          />
          <Button className="mt-8" variant="outline" render={<Link href="/login" />}>
            {t("forgot.backToLogin")}
          </Button>
        </>
      ) : (
        <>
          <AuthHeading
            eyebrow={t("forgot.eyebrow")}
            title={t("forgot.title")}
            subtitle={t("forgot.subtitle")}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault()
              request.mutate()
            }}
            className="mt-8 flex flex-col gap-5"
          >
            <FormRow label={t("forgot.email")} htmlFor="forgot-email">
              <Input
                id="forgot-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                dir="ltr"
              />
            </FormRow>
            <FormError message={request.error ? errorMessage(request.error) : null} />
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={request.isPending}
              disabled={!email.trim()}
            >
              {t("forgot.submit")}
            </Button>
            <Link
              href="/login"
              className="text-center text-sm text-foreground-secondary underline-offset-2 hover:underline"
            >
              {t("forgot.backToLogin")}
            </Link>
          </form>
        </>
      )}
    </AuthShell>
  )
}
