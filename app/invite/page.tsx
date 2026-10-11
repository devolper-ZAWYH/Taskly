import { Suspense } from "react"
import { SetPasswordPage } from "@/features/auth/set-password-page"

export default function Page() {
  return (
    // useSearchParams (for ?token=…) must sit inside a Suspense boundary.
    <Suspense>
      <SetPasswordPage kind="invite" />
    </Suspense>
  )
}
