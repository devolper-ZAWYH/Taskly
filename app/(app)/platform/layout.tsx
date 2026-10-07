"use client"

import { useRouter } from "next/navigation"
import * as React from "react"
import { useCurrentUser } from "@/features/auth/use-auth"

/** Platform console is operator-only. */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const me = useCurrentUser()
  const router = useRouter()

  React.useEffect(() => {
    if (!me.isOperator) router.replace("/workspaces")
  }, [me.isOperator, router])

  return me.isOperator ? <>{children}</> : null
}
