"use client"

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as React from "react"
import { InstallPrompt } from "@/components/shell/install-prompt"
import { ToastProvider } from "@/components/ui/toast"
import { AppError } from "@/lib/api/core"
import { LocaleProvider } from "@/lib/i18n/locale-provider"
import type { Locale } from "@/lib/types"

/**
 * A call that finds no valid session (expired, signed out elsewhere, user
 * deactivated…) signs out cleanly instead of leaving the UI half signed-in.
 */
function handleSessionError(error: unknown) {
  if (error instanceof AppError && error.code === "unauthorized") {
    if (!window.location.pathname.startsWith("/login")) window.location.replace("/login")
  }
}

export function Providers({
  initialLocale,
  children,
}: {
  initialLocale: Locale
  children: React.ReactNode
}): React.ReactElement {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleSessionError }),
        mutationCache: new MutationCache({ onError: handleSessionError }),
        defaultOptions: {
          // Teammates change data too: refresh when the tab comes back into focus.
          queries: { retry: false, refetchOnWindowFocus: true, staleTime: 10_000 },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider initialLocale={initialLocale}>
        <ToastProvider position="bottom-center">{children}</ToastProvider>
        <InstallPrompt />
      </LocaleProvider>
    </QueryClientProvider>
  )
}
