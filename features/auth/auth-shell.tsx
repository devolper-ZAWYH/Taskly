"use client"

import * as React from "react"
import { BrandMark } from "@/components/shell/brand"
import { LanguageToggle } from "@/components/shell/language-toggle"
import { useLocale } from "@/lib/i18n/locale-provider"

/** The signed-out page frame: brand and language at the top, a narrow column below. */
export function AuthShell({
  children,
  testId,
}: {
  children: React.ReactNode
  testId?: string
}): React.ReactElement {
  const { t } = useLocale()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center justify-between border-b px-4 sm:px-8">
        <BrandMark wordmark={t("app.name")} />
        <LanguageToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm" data-testid={testId}>
          {children}
        </div>
      </main>
    </div>
  )
}

export function AuthHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string
  title: string
  subtitle?: string
}): React.ReactElement {
  return (
    <>
      {eyebrow ? <span className="eyebrow block">{eyebrow}</span> : null}
      <h1 className="font-display text-[32px] leading-tight font-extrabold tracking-[-0.02em] text-foreground">
        {title}
      </h1>
      {subtitle ? <p className="mt-2 text-sm text-foreground-secondary">{subtitle}</p> : null}
    </>
  )
}
