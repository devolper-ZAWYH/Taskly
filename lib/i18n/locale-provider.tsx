"use client"

import * as React from "react"
import { AppError } from "@/lib/api/core"
import { LOCALE_COOKIE } from "@/lib/i18n/locale-cookie"
import type { Locale } from "@/lib/types"
import ar from "@/messages/ar"
import en, { type Messages } from "@/messages/en"

const DICTIONARIES: Record<Locale, Messages> = { en, ar }

/** Dot-path keys into the dictionary, e.g. "tasks.tabs.mine". */
type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>
}[keyof T & string]

export type MessageKey = Paths<Messages>

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

type LocaleContextValue = {
  locale: Locale
  dir: "ltr" | "rtl"
  /** BCP-47 tag for Intl formatters (Arabic uses Latin digits). */
  intl: string
  setLocale: (locale: Locale) => void
  t: Translate
  /** Translate an error thrown by the mock API (or anything else). */
  errorMessage: (error: unknown) => string
  formatDate: (ymd: string, time?: string) => string
  formatDateTime: (iso: string) => string
}

const LocaleContext = React.createContext<LocaleContextValue | null>(null)

function lookup(dict: Messages, key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict)
  return typeof value === "string" ? value : key
}

function intlLocale(locale: Locale): string {
  // Arabic text with Latin digits, common in Gulf business apps.
  return locale === "ar" ? "ar-QA-u-nu-latn" : "en-GB"
}

export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale
  children: React.ReactNode
}): React.ReactElement {
  const [locale, setLocaleState] = React.useState<Locale>(initialLocale)
  const dir = locale === "ar" ? "rtl" : "ltr"

  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next)
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
  }, [])

  React.useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = dir
  }, [locale, dir])

  const value = React.useMemo<LocaleContextValue>(() => {
    const dict = DICTIONARIES[locale]
    const t: Translate = (key, vars) => {
      let text = lookup(dict, key)
      if (vars) {
        for (const [name, v] of Object.entries(vars)) {
          text = text.replaceAll(`{${name}}`, String(v))
        }
      }
      return text
    }
    const dateFmt = new Intl.DateTimeFormat(intlLocale(locale), {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
    const timeFmt = new Intl.DateTimeFormat(intlLocale(locale), {
      hour: "2-digit",
      minute: "2-digit",
    })
    return {
      locale,
      dir,
      intl: intlLocale(locale),
      setLocale,
      t,
      errorMessage: (error) =>
        error instanceof AppError ? t(`errors.${error.code}` as MessageKey) : t("errors.generic"),
      formatDate: (ymd, time) => {
        if (!ymd) return "—"
        const date = new Date(`${ymd}T${time || "00:00"}:00`)
        return time ? `${dateFmt.format(date)}, ${timeFmt.format(date)}` : dateFmt.format(date)
      },
      formatDateTime: (iso) => {
        const date = new Date(iso)
        return `${dateFmt.format(date)}, ${timeFmt.format(date)}`
      },
    }
  }, [locale, dir, setLocale])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = React.useContext(LocaleContext)
  if (!ctx) throw new Error("useLocale must be used inside LocaleProvider")
  return ctx
}
