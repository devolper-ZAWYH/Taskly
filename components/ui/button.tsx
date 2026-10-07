"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { Loader2Icon } from "lucide-react"
import { cn } from "@/lib/utils"

export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border text-base font-medium whitespace-nowrap transition-[transform,box-shadow] outline-none before:pointer-events-none before:absolute before:inset-0 before:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-loading:text-transparent data-loading:select-none sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [:active,[data-pressed]]:scale-97",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "border-brand bg-brand text-brand-foreground shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:bg-brand-hover data-pressed:bg-brand-active *:data-[slot=button-loading-indicator]:text-brand-foreground [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
        destructive:
          "border-destructive bg-destructive text-white shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:bg-destructive/90 data-pressed:bg-destructive/90 *:data-[slot=button-loading-indicator]:text-white [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
        "destructive-outline":
          "border-input bg-surface text-destructive-foreground shadow-xs/5 hover:border-destructive/32 hover:bg-destructive-bg data-pressed:border-destructive/32 data-pressed:bg-destructive-bg *:data-[slot=button-loading-indicator]:text-foreground dark:bg-surface-elevated [:disabled,:active,[data-pressed]]:shadow-none",
        ghost:
          "border-transparent text-foreground hover:bg-ghost-hover data-pressed:bg-ghost-hover *:data-[slot=button-loading-indicator]:text-foreground",
        link: "border-transparent text-foreground underline-offset-4 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground",
        outline:
          "border-input bg-surface text-secondary-foreground shadow-xs/5 hover:bg-surface-muted data-pressed:bg-surface-muted *:data-[slot=button-loading-indicator]:text-foreground dark:bg-surface-elevated dark:hover:bg-surface-strong dark:data-pressed:bg-surface-strong [:disabled,:active,[data-pressed]]:shadow-none",
        secondary:
          "border border-input bg-surface text-secondary-foreground shadow-xs/5 hover:bg-surface-muted data-pressed:bg-surface-muted *:data-[slot=button-loading-indicator]:text-secondary-foreground dark:bg-surface-elevated dark:hover:bg-surface-strong dark:data-pressed:bg-surface-strong",
        brand:
          "border-brand bg-brand text-brand-foreground shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:bg-brand-hover data-pressed:bg-brand-active *:data-[slot=button-loading-indicator]:text-brand-foreground [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
      },
    },
  }
)

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"]
  size?: VariantProps<typeof buttonVariants>["size"]
  loading?: boolean
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  disabled: disabledProp,
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled: boolean = Boolean(loading || disabledProp)
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
    render ? undefined : "button"

  const defaultProps = {
    children: (
      <>
        {children}
        {loading && (
          <Loader2Icon
            className="pointer-events-none absolute animate-spin"
            data-slot="button-loading-indicator"
          />
        )}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    "aria-disabled": loading || undefined,
    "data-loading": loading ? "" : undefined,
    "data-slot": "button",
    disabled: isDisabled,
    type: typeValue,
  }

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  })
}
