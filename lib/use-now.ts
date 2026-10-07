import * as React from "react"

/** Current time, refreshed every minute (for "today" markers and the now-line). */
export function useNow(): Date {
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}
