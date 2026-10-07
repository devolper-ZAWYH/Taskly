"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import type React from "react"
import { cn } from "@/lib/utils"

export const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 rounded-full border border-transparent font-medium whitespace-nowrap transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default:
          "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs",
        lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm",
        sm: "h-5 min-w-5 px-[calc(--spacing(1)-1px)] text-xs sm:h-4 sm:min-w-4 sm:text-[.625rem]",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground [button&,a&]:hover:bg-brand-hover",
        brand:
          "bg-brand-surface text-brand-ink [button&,a&]:hover:bg-brand-surface-subtle",
        destructive:
          "bg-destructive text-white [button&,a&]:hover:bg-destructive/90",
        error: "bg-destructive-bg text-destructive-foreground",
        info: "bg-info-bg text-info-foreground",
        outline:
          "border-input bg-background text-foreground [button&,a&]:hover:bg-surface-hover",
        secondary:
          "bg-surface-muted text-secondary-foreground [button&,a&]:hover:bg-surface-hover",
        success: "bg-success-bg text-success-foreground",
        warning: "bg-warning-bg text-warning-foreground",
      },
    },
  }
)

export interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"]
  size?: VariantProps<typeof badgeVariants>["size"]
}

export function Badge({
  className,
  variant,
  size,
  render,
  ...props
}: BadgeProps): React.ReactElement {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  }

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  })
}
