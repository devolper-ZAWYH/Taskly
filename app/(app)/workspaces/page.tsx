"use client"

import { ArrowRightIcon, Loader2Icon } from "lucide-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import * as React from "react"
import { PageHeader } from "@/components/shell/page-header"
import { Badge } from "@/components/ui/badge"
import { useCurrentUser } from "@/features/auth/use-auth"
import { useMyWorkspaces, workspacePath } from "@/features/workspace/workspace-context"
import { useLocale } from "@/lib/i18n/locale-provider"
import { getLastWorkspaceId } from "@/lib/preferences"
import { cn } from "@/lib/utils"

function WorkspacesPicker() {
  const { t } = useLocale()
  const me = useCurrentUser()
  const router = useRouter()
  const auto = useSearchParams().get("auto") === "1"
  const { data: workspaces, isPending } = useMyWorkspaces()

  // On arrival (login, "/"), skip the picker when the choice is obvious.
  const target = React.useMemo(() => {
    if (!auto || !workspaces) return null
    if (me.isOperator) return "/platform"
    const own = workspaces.filter((w) => !w.viaOperator && w.account.active)
    if (own.length === 1) return workspacePath(own[0].account.id, "/tasks")
    const last = own.find((w) => w.account.id === getLastWorkspaceId(me.id))
    return last ? workspacePath(last.account.id, "/tasks") : null
  }, [auto, workspaces, me.isOperator, me.id])

  React.useEffect(() => {
    if (target) router.replace(target)
  }, [target, router])

  if (isPending || target) {
    return (
      <div className="grid place-items-center py-24">
        <Loader2Icon className="size-5 animate-spin text-foreground-muted" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("workspaces.eyebrow")}
        title={t("workspaces.title")}
        subtitle={t("workspaces.subtitle")}
      />
      {workspaces && workspaces.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {workspaces.map((w) => (
            <li key={w.account.id}>
              <Link
                href={workspacePath(w.account.id, "/tasks")}
                className={cn(
                  "group flex items-center justify-between gap-4 rounded-md border p-5 transition-colors hover:border-foreground",
                  !w.account.active && "opacity-60",
                )}
              >
                <span className="min-w-0">
                  <span className="font-display block truncate text-xl">{w.account.name}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-5 px-2 text-xs",
                        w.role === "administrator"
                          ? "border-transparent bg-foreground text-background"
                          : "border-foreground/25",
                      )}
                    >
                      {w.viaOperator ? t("workspaces.operatorAccess") : t(`roles.${w.role}`)}
                    </Badge>
                    {!w.account.active ? (
                      <Badge variant="outline" className="h-5 px-2 text-xs">
                        {t("common.inactive")}
                      </Badge>
                    ) : null}
                  </span>
                </span>
                <ArrowRightIcon className="rtl-flip size-5 shrink-0 text-foreground-muted transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-foreground-muted">
          {t("workspaces.none")}
        </p>
      )}
    </div>
  )
}

export default function WorkspacesPage() {
  return (
    <React.Suspense>
      <WorkspacesPicker />
    </React.Suspense>
  )
}
