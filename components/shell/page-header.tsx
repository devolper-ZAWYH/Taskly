export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string
  title: string
  subtitle?: string
  actions?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b pb-6">
      <div className="min-w-0">
        <span className="eyebrow block">{eyebrow}</span>
        <h1 className="font-display mt-2 text-[28px] leading-tight font-extrabold tracking-[-0.02em] text-foreground sm:text-[32px]">
          {title}
        </h1>
        {subtitle ? <p className="mt-1.5 text-sm text-foreground-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
