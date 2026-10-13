"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { BrandMark } from "@/components/shell/brand"
import { FormError, FormRow } from "@/components/shell/form-row"
import { LanguageToggle } from "@/components/shell/language-toggle"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { homePath, safeNext, useLogin, useMe } from "@/features/auth/use-auth"
import { useLocale } from "@/lib/i18n/locale-provider"

export default function LoginPage() {
  // useSearchParams (for ?next=) must sit inside a Suspense boundary.
  return (
    <React.Suspense>
      <LoginForm />
    </React.Suspense>
  )
}

function LoginForm() {
  const { t, errorMessage } = useLocale()
  const router = useRouter()
  // Where to go afterwards, e.g. back to Claude's consent screen.
  const next = safeNext(useSearchParams().get("next"))
  const me = useMe()
  const loginMutation = useLogin(next)
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")

  React.useEffect(() => {
    if (me.data) router.replace(next ?? homePath(me.data))
  }, [me.data, next, router])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    loginMutation.mutate({ email, password })
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center justify-between border-b px-4 sm:px-8">
        <BrandMark wordmark={t("app.name")} />
        <LanguageToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <span className="eyebrow block">{t("login.eyebrow")}</span>
          <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-[-0.02em] text-foreground">{t("login.title")}</h1>
          <p className="mt-2 text-sm text-foreground-secondary">{t("login.subtitle")}</p>

          <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
            <FormRow label={t("login.email")} htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                dir="ltr"
              />
            </FormRow>
            <FormRow label={t("login.password")} htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                dir="ltr"
              />
            </FormRow>
            <Link
              href="/forgot-password"
              className="-mt-3 self-end text-xs text-foreground-secondary underline-offset-2 hover:underline"
            >
              {t("login.forgot")}
            </Link>
            <FormError message={loginMutation.error ? errorMessage(loginMutation.error) : null} />
            <Button type="submit" size="lg" loading={loginMutation.isPending} className="w-full">
              {t("login.submit")}
            </Button>
          </form>

        </div>
      </main>
    </div>
  )
}
