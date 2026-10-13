import { Suspense } from "react"
import { ConsentPage } from "@/features/connector/consent-page"

/** Claude's sign-in and consent screen (Taskly is the OAuth server for its connector). */
export default function AuthorizePage() {
  // useSearchParams (the OAuth request) must sit inside a Suspense boundary.
  return (
    <Suspense>
      <ConsentPage />
    </Suspense>
  )
}
