import { cn } from "@/lib/utils"

/** Label + control + optional hint, used by every form in the prototype. */
export function FormRow({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="eyebrow">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-foreground-muted">{hint}</p> : null}
    </div>
  )
}

export function FormError({ message }: { message: string | null }): React.ReactElement | null {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive-bg px-3 py-2 text-sm text-destructive-foreground"
    >
      {message}
    </p>
  )
}
