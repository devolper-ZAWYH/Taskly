"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckIcon, MonitorIcon, ShieldCheckIcon } from "lucide-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { ClaudeMark } from "@/components/shell/claude-mark"
import { FormError } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AuthHeading, AuthShell } from "@/features/auth/auth-shell"
import { ME_KEY, useMe } from "@/features/auth/use-auth"
import { logout } from "@/lib/api/auth"
import {
  approveAuthorization,
  denyAuthorization,
  describeAuthorization,
  type AuthorizeParams,
} from "@/lib/api/connector"
import { useLocale } from "@/lib/i18n/locale-provider"

/**
 * /oauth/authorize: Claude asks to connect to this person's Taskly account.
 * Signed out → sign in first and come back here. Answers go back to the app
 * by navigating the page (not a form post), so the site's `form-action 'self'`
 * policy stays as strict as it is.
 */
export function ConsentPage(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const router = useRouter()
  const queryClient = useQueryClient()
  const search = useSearchParams()
  const query = search.toString()
  const params = React.useMemo<AuthorizeParams>(() => Object.fromEntries(new URLSearchParams(query)), [query])
  const here = `/oauth/authorize?${query}`
  const me = useMe()

  React.useEffect(() => {
    if (me.data === null) router.replace(`/login?next=${encodeURIComponent(here)}`)
  }, [me.data, here, router])

  const request = useQuery({
    queryKey: ["consent", query],
    queryFn: () => describeAuthorization(params),
    enabled: Boolean(me.data),
    retry: false,
    staleTime: Infinity,
  })

  // Problems the app should hear about (unsupported scope, missing PKCE…) go straight back to it.
  React.useEffect(() => {
    if (request.data?.kind === "redirect" && request.data.redirectUrl) {
      window.location.assign(request.data.redirectUrl)
    }
  }, [request.data])

  const answer = useMutation({
    mutationFn: (allow: boolean) => (allow ? approveAuthorization(params) : denyAuthorization(params)),
    onSuccess: ({ redirectUrl }) => window.location.assign(redirectUrl),
  })

  async function switchAccount() {
    await logout()
    queryClient.setQueryData(ME_KEY, null)
    router.replace(`/login?next=${encodeURIComponent(here)}`)
  }

  if (request.isError) {
    return (
      <AuthShell testId="consent-error">
        <AuthHeading eyebrow={t("claude.consent.eyebrow")} title={t("claude.consent.errorTitle")} />
        <p className="mt-4 text-sm text-foreground-secondary">{errorMessage(request.error)}</p>
        <Button className="mt-8 w-full" variant="outline" render={<Link href="/" />}>
          {t("claude.consent.backToTaskly")}
        </Button>
      </AuthShell>
    )
  }

  const consent = request.data?.kind === "consent" ? request.data : null
  if (!me.data || !consent) {
    return (
      <AuthShell testId="consent-loading">
        <Skeleton className="h-8 w-3/4 rounded-md" />
        <Skeleton className="mt-6 h-40 w-full rounded-md" />
      </AuthShell>
    )
  }

  const appLabel = consent.app.name || consent.app.host
  const canWrite = consent.scopes.includes("taskly.write")
  return (
    <AuthShell testId="consent">
      <div className="mb-6 flex items-center gap-3">
        <ClaudeMark className="size-10" />
        <span className="text-foreground-muted" aria-hidden>
          ⟷
        </span>
        <span className="font-display text-lg font-bold">{t("app.name")}</span>
      </div>
      <AuthHeading
        eyebrow={t("claude.consent.eyebrow")}
        title={t("claude.consent.title", { app: appLabel })}
      />

      <dl className="mt-6 grid gap-1 rounded-md border p-4 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-foreground-muted">{t("claude.consent.appAddress")}</dt>
          <dd dir="ltr" className="font-medium" data-testid="consent-host">
            {consent.app.host}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-foreground-muted">{t("claude.consent.returnsTo")}</dt>
          <dd dir="ltr" className="font-medium">
            {consent.redirectHost}
          </dd>
        </div>
        {consent.app.local ? (
          <p className="mt-2 flex items-start gap-2 text-xs text-foreground-secondary">
            <MonitorIcon className="mt-0.5 size-3.5 shrink-0" />
            {t("claude.consent.local")}
          </p>
        ) : null}
      </dl>

      <p className="mt-6 text-sm font-medium">{t("claude.consent.canDo", { app: appLabel })}</p>
      <ul className="mt-2 grid gap-2 text-sm text-foreground-secondary">
        <li className="flex gap-2">
          <CheckIcon className="mt-0.5 size-4 shrink-0" />
          {t("claude.consent.scopeRead")}
        </li>
        {canWrite ? (
          <li className="flex gap-2">
            <CheckIcon className="mt-0.5 size-4 shrink-0" />
            {t("claude.consent.scopeWrite")}
          </li>
        ) : null}
      </ul>
      <p className="mt-4 flex gap-2 text-xs text-foreground-muted">
        <ShieldCheckIcon className="size-4 shrink-0" />
        {t("claude.consent.limits")}
      </p>

      <p className="mt-6 text-sm text-foreground-secondary">
        {t("claude.consent.signedInAs", { name: me.data.name, email: me.data.email })}{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => void switchAccount()}
        >
          {t("claude.consent.notYou")}
        </button>
      </p>

      <FormError message={answer.error ? errorMessage(answer.error) : null} />
      <div className="mt-6 flex gap-3">
        <Button
          className="flex-1"
          size="lg"
          loading={answer.isPending && answer.variables === true}
          disabled={answer.isPending || answer.isSuccess}
          onClick={() => answer.mutate(true)}
          data-testid="consent-allow"
        >
          {t("claude.consent.allow")}
        </Button>
        <Button
          className="flex-1"
          size="lg"
          variant="outline"
          loading={answer.isPending && answer.variables === false}
          disabled={answer.isPending || answer.isSuccess}
          onClick={() => answer.mutate(false)}
          data-testid="consent-deny"
        >
          {t("claude.consent.deny")}
        </Button>
      </div>
    </AuthShell>
  )
}
