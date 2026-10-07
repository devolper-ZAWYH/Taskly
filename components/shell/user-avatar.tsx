"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")
  ).toUpperCase()
}

/** A person's photo when they have one, otherwise their initials. */
export function UserAvatar({
  name,
  src,
  inactive = false,
  size = "md",
  className,
}: {
  name: string
  /** `avatarUrl` from the user; null/undefined shows initials. */
  src?: string | null
  inactive?: boolean
  size?: "sm" | "md"
  className?: string
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)
  const showPhoto = Boolean(src) && !failed
  return (
    <span
      title={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium select-none ring-2 ring-background",
        size === "sm" ? "size-6 text-[10px]" : "size-8 text-xs",
        inactive ? "bg-surface-strong text-foreground-muted" : "bg-foreground text-background",
        showPhoto && inactive && "opacity-60 grayscale",
        className,
      )}
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element -- small, versioned, private
        <img src={src!} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        initials(name)
      )}
    </span>
  )
}
