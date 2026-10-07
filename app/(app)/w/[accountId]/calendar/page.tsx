import { Suspense } from "react"
import { CalendarPage } from "@/features/calendar/components/calendar-page"

export default function Page() {
  // useSearchParams (view/date/meeting) must sit inside a Suspense boundary.
  return (
    <Suspense>
      <CalendarPage />
    </Suspense>
  )
}
