import { Suspense } from "react"
import { PlatformUsersPage } from "@/features/platform/components/platform-users-page"

export default function Page() {
  return (
    <Suspense>
      <PlatformUsersPage />
    </Suspense>
  )
}
