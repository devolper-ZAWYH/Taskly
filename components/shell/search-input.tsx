"use client"

import { SearchIcon, XIcon } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}): React.ReactElement {
  return (
    <InputGroup className={cn("w-full sm:w-72", className)}>
      <InputGroupAddon>
        <SearchIcon className="text-foreground-muted" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <InputGroupAddon align="inline-end">
          <button
            type="button"
            onClick={() => onChange("")}
            className="cursor-pointer rounded-sm p-0.5 text-foreground-muted hover:text-foreground"
            aria-label="Clear"
          >
            <XIcon className="size-3.5" />
          </button>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  )
}
