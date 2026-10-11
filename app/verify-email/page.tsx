import { Suspense } from "react"
import { VerifyEmailPage } from "@/features/auth/verify-email-page"

export default function Page() {
  return (
    // useSearchParams (for ?token=…) must sit inside a Suspense boundary.
    <Suspense>
      <VerifyEmailPage />
    </Suspense>
  )
}
