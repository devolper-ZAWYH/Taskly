"use client"

import { isValidElement, type ReactElement, type ReactNode } from "react"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/** Tooltip for sidebar rail items; renders the child untouched when hidden. */
export function NavTooltip({
  content,
  side = "inline-end",
  hidden,
  children,
  className,
}: {
  content: ReactNode
  side?: "top" | "bottom" | "inline-start" | "inline-end"
  hidden?: boolean
  children: ReactNode
  className?: string
}): React.ReactElement {
  if (hidden || !isValidElement(children)) return <>{children}</>

  return (
    <Tooltip>
      <TooltipTrigger render={children as ReactElement<Record<string, unknown>>} />
      <TooltipPopup
        side={side}
        sideOffset={8}
        className={cn(
          "z-50 border-border/60 bg-popover px-2.5 py-1.5 text-xs font-medium whitespace-pre-line text-popover-foreground shadow-md",
          className,
        )}
      >
        {content}
      </TooltipPopup>
    </Tooltip>
  )
}
