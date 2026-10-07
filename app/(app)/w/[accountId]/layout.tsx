"use client"

import { Loader2Icon, ShieldIcon } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { useCurrentUser } from "@/features/auth/use-auth"
import { useMyWorkspaces, WorkspaceProvider } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import { setLastWorkspaceId } from "@/lib/preferences"

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { t } = useLocale()
  const { accountId } = useParams<{ accountId: string }>()
  const me = useCurrentUser()
  const workspaces = useMyWorkspaces()
  const workspace = workspaces.data?.find((w) => w.account.id === accountId)

  React.useEffect(() => {
    if (workspace) setLastWorkspaceId(me.id, workspace.account.id)
  }, [workspace, me.id])

  if (workspaces.isPending) {
    return (
      <div className="grid place-items-center py-24">
        <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
      </div>
    )
  }

  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-24 text-center">
        <h1 className="font-display text-3xl">{t("workspaces.noAccessTitle")}</h1>
        <p className="mt-2 text-sm text-foreground-secondary">{t("workspaces.noAccess")}</p>
        <Button className="mt-6" render={<Link href="/workspaces" />}>
          {t("workspaces.choose")}
        </Button>
      </div>
    )
  }

  return (
    <WorkspaceProvider workspace={workspace}>
      {workspace.viaOperator ? (
        <div className="mb-6 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-foreground-secondary">
          <ShieldIcon className="size-3.5 shrink-0" />
          {t("workspaces.operatorView")}
        </div>
      ) : null}
      {!workspace.account.active ? (
        <div className="mb-6 rounded-md border border-destructive/30 bg-destructive-bg px-3 py-2 text-xs text-destructive-foreground">
          {t("workspaces.inactiveBanner")}
        </div>
      ) : null}
      {children}
    </WorkspaceProvider>
  )
}
