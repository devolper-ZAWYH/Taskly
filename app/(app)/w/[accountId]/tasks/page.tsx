import { Suspense } from "react"
import { TasksPage } from "@/features/tasks/components/tasks-page"

export default function Page() {
  // useSearchParams (for ?task=<id>) must sit inside a Suspense boundary.
  return (
    <Suspense>
      <TasksPage />
    </Suspense>
  )
}
