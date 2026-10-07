import { cn } from "@/lib/utils"

/** The Taskly mark (static, so browsers cache it) plus the product name. */
export function BrandMark({
  className,
  wordmark,
}: {
  className?: string
  wordmark: string
}): React.ReactElement {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- static vector mark */}
      <img src="/brand/taskly.svg" alt="" width={28} height={28} className="size-7 shrink-0" />
      <span className="font-display text-xl leading-none font-extrabold tracking-[-0.02em] text-foreground">
        {wordmark}
      </span>
    </span>
  )
}

/**
 * The current workspace's logo when it has one, otherwise the product mark.
 * Logos keep their own proportions inside a fixed height.
 */
export function WorkspaceBrand({
  logoUrl,
  name,
  wordmark,
  className,
}: {
  logoUrl: string | null | undefined
  name: string | undefined
  wordmark: string
  className?: string
}): React.ReactElement {
  if (!logoUrl) return <BrandMark wordmark={wordmark} className={className} />
  return (
    // eslint-disable-next-line @next/next/no-img-element -- versioned, private, already sized
    <img
      src={logoUrl}
      alt={name ?? wordmark}
      data-testid="workspace-logo"
      className={cn("h-8 w-auto max-w-full object-contain object-left rtl:object-right", className)}
    />
  )
}
