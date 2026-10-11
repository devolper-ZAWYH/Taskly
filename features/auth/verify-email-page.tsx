"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AuthHeading, AuthShell } from "@/features/auth/auth-shell"
import { AppError } from "@/lib/api/core"
import { confirmEmail } from "@/lib/api/emails"
import { useLocale } from "@/lib/i18n/locale-provider"

/** `/verify-email?token=…`: the link from the confirmation email. Works signed out. */
export function VerifyEmailPage(): React.ReactElement {
  const { t } = useLocale()
  const token = useSearchParams().get("token") ?? ""
  const result = useQuery({
    queryKey: ["confirm-email", token],
    queryFn: () => confirmEmail(token),
    enabled: Boolean(token),
    retry: false,
    staleTime: Infinity,
  })

  return (
    <AuthShell testId="verify-email-page">
      {token && result.isPending ? (
        <Skeleton className="h-40 w-full rounded-md" />
      ) : result.data ? (
        <AuthHeading
          title={t("verifyEmail.title")}
          subtitle={t("verifyEmail.body", { email: result.data.email })}
        />
      ) : (
        <AuthHeading
          title={t("verifyEmail.invalidTitle")}
          subtitle={
            result.error instanceof AppError && result.error.code === "emailTaken"
              ? t("verifyEmail.takenBody")
              : t("verifyEmail.invalidBody")
          }
        />
      )}
      {!token || !result.isPending ? (
        <Button className="mt-8" render={<Link href="/" />}>
          {t("verifyEmail.open")}
        </Button>
      ) : null}
    </AuthShell>
  )
}
