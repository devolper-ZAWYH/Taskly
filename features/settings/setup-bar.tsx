"use client"

import { TriangleAlertIcon, XIcon } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { ClaudeMark } from "@/components/shell/claude-mark"
import { GoogleLogo } from "@/components/shell/google-logo"
import { Button } from "@/components/ui/button"
import { useCurrentUser } from "@/features/auth/use-auth"
import { useClaudeSetup } from "@/features/connector/hooks"
import { useGoogleStatus } from "@/features/google/hooks"
import { useMyWorkspaces } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import { getSetupBarHidden, hideSetupBar } from "@/lib/preferences"

// The "hide for now" choice lives in localStorage; these let React re-read it after a click.
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The bar across the top of the app while someone hasn't connected Google
 * or Claude, with a button to each in Settings. "Hide for now" puts the
 * suggestions away for a week on this browser; a Google connection that
 * stopped working always shows, because their sync is broken until they act.
 */
export function SetupBar(): React.ReactElement | null {
  const { t } = useLocale()
  const me = useCurrentUser()
  const workspaces = useMyWorkspaces()
  const google = useGoogleStatus()
  const claude = useClaudeSetup()
  // Hidden while server-rendering, so a hidden bar never flashes.
  const hidden = React.useSyncExternalStore(subscribe, () => getSetupBarHidden(me.id), () => true)

  // Both only matter to people who work in a workspace. Operators see every
  // workspace (viaOperator), but that doesn't make them members of any.
  if (!workspaces.data?.some((w) => !w.viaOperator)) return null
  const g = google.data
  const c = claude.data
  const reconnectGoogle = Boolean(g?.configured && g.connected && g.state === "revoked")
  const connectGoogle = Boolean(g?.configured && !g.connected) && !hidden
  const connectClaude = Boolean(c?.available && c.publicUrl && c.connections.length === 0) && !hidden
  if (!reconnectGoogle && !connectGoogle && !connectClaude) return null

  const message = reconnectGoogle
    ? t("setupBar.googleReconnect")
    : connectGoogle && connectClaude
      ? t("setupBar.both")
      : connectGoogle
        ? g?.tasksEnabled
          ? t("setupBar.google")
          : t("setupBar.googleCalendar")
        : t("setupBar.claude")

  function hide() {
    hideSetupBar(me.id)
    listeners.forEach((listener) => listener())
  }

  return (
    <div
      role="region"
      aria-label={t("setupBar.label")}
      className="border-b border-destructive/20 bg-destructive-bg text-destructive-foreground"
      data-testid="setup-bar"
    >
      <div className="mx-auto flex w-full max-w-6xl items-start gap-3 px-4 py-2.5 sm:items-center sm:px-8">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 sm:mt-0" aria-hidden="true" />
        {/* Phones: the message on its own lines, the buttons under it. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <p className="min-w-0 flex-1 text-sm font-medium">{message}</p>
          <div className="flex flex-wrap items-center gap-2">
            {(reconnectGoogle || connectGoogle) && (
              <Button size="sm" variant="destructive" render={<Link href="/settings#google" />}>
                <LogoTile>
                  <GoogleLogo className="size-3" />
                </LogoTile>
                {reconnectGoogle ? t("setupBar.reconnectGoogle") : t("setupBar.connectGoogle")}
              </Button>
            )}
            {connectClaude && (
              <Button size="sm" variant="destructive" render={<Link href="/settings#claude" />}>
                <LogoTile>
                  <ClaudeMark className="size-3" />
                </LogoTile>
                {t("setupBar.connectClaude")}
              </Button>
            )}
          </div>
        </div>
        {!reconnectGoogle && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="-my-1 text-destructive-foreground hover:bg-destructive/10"
            aria-label={t("setupBar.hide")}
            title={t("setupBar.hide")}
            onClick={hide}
          >
            <XIcon />
          </Button>
        )}
      </div>
    </div>
  )
}

/** A white tile, so each brand's own colours show on the red button. */
function LogoTile({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="grid size-4.5 shrink-0 place-items-center rounded-sm bg-white">{children}</span>
}
