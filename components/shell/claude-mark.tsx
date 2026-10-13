"use client"

import { SparklesIcon } from "lucide-react"
import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * Claude's logo, next to "Set up MCP" and on the consent screen. Use
 * Anthropic's official SVG, unmodified, saved as public/brand/claude.svg
 * (check Anthropic's brand guidelines first; docs/plan-claude-connector.md
 * §9a). Until that file exists, a neutral mark stands in.
 */
export function ClaudeMark({ className }: { className?: string }): React.ReactElement {
  const [missing, setMissing] = React.useState(false)
  if (missing) {
    return (
      <span
        aria-hidden
        className={cn("grid shrink-0 place-items-center rounded-md bg-surface-strong", className)}
      >
        <SparklesIcon className="size-1/2" />
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small static brand asset
    <img
      src="/brand/claude.svg"
      alt=""
      aria-hidden
      className={cn("shrink-0", className)}
      onError={() => setMissing(true)}
    />
  )
}
