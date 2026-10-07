"use client"

import { EyeIcon, EyeOffIcon } from "lucide-react"
import * as React from "react"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { useLocale } from "@/lib/i18n/locale-provider"

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete = "new-password",
  disabled,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  autoComplete?: string
  disabled?: boolean
}): React.ReactElement {
  const { t } = useLocale()
  const [visible, setVisible] = React.useState(false)
  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
        dir="ltr"
        onChange={(e) => onChange(e.target.value)}
      />
      <InputGroupAddon align="inline-end">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="cursor-pointer rounded-sm p-0.5 text-foreground-muted hover:text-foreground"
          aria-label={visible ? t("common.hide") : t("common.show")}
        >
          {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </button>
      </InputGroupAddon>
    </InputGroup>
  )
}
