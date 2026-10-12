import { Suspense } from "react"
import { MinutesPage } from "@/features/minutes/minutes-page"

export default function Page() {
  // useSearchParams (for ?minutes=<id>) must sit inside a Suspense boundary.
  return (
    <Suspense>
      <MinutesPage />
    </Suspense>
  )
}
