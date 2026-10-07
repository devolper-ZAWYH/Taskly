"use client"

import { useQuery } from "@tanstack/react-query"
import * as React from "react"
import { useCurrentUser } from "@/features/auth/use-auth"
import { listMyWorkspaces } from "@/lib/api/auth"
import type { Viewer } from "@/lib/api/tasks"
import type { Account, MyWorkspace, Role } from "@/lib/types"

export const MY_WORKSPACES_KEY = ["my-workspaces"] as const

export function useMyWorkspaces() {
  return useQuery({ queryKey: MY_WORKSPACES_KEY, queryFn: listMyWorkspaces })
}

type WorkspaceValue = {
  accountId: string
  account: Account
  /** The signed-in user's role in this workspace (operators act as Administrator). */
  role: Role
  isAdmin: boolean
  /** True when an operator is viewing a workspace they're not a member of. */
  viaOperator: boolean
}

const WorkspaceContext = React.createContext<WorkspaceValue | null>(null)

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: MyWorkspace
  children: React.ReactNode
}): React.ReactElement {
  const value = React.useMemo<WorkspaceValue>(
    () => ({
      accountId: workspace.account.id,
      account: workspace.account,
      role: workspace.role,
      isAdmin: workspace.role === "administrator",
      viaOperator: workspace.viaOperator,
    }),
    [workspace],
  )
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceValue {
  const ctx = React.useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used inside a workspace route")
  return ctx
}

/** Same as useWorkspace but null outside a workspace (e.g. in the top bar). */
export function useOptionalWorkspace(): WorkspaceValue | null {
  return React.useContext(WorkspaceContext)
}

/** Builds links inside the current workspace: `wsPath("/tasks")` → `/w/<id>/tasks`. */
export function workspacePath(accountId: string, path: string): string {
  return `/w/${accountId}${path}`
}

export function useWorkspacePath(): (path: string) => string {
  const { accountId } = useWorkspace()
  return React.useCallback((path: string) => workspacePath(accountId, path), [accountId])
}

/** The signed-in user with their role in this workspace, for permission checks. */
export function useViewer(): Viewer {
  const me = useCurrentUser()
  const { role } = useWorkspace()
  return { id: me.id, role }
}
