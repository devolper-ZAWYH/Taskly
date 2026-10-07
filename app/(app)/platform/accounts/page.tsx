import { Suspense } from "react"
import { AccountsPage } from "@/features/platform/components/accounts-page"

export default function Page() {
  return (
    <Suspense>
      <AccountsPage />
    </Suspense>
  )
}
