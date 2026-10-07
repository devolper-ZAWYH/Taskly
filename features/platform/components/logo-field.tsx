"use client"

import { ImageIcon, Trash2Icon, UploadIcon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import { useSetAccountLogo } from "@/features/platform/hooks/use-platform"
import { AppError } from "@/lib/api/core"
import { useLocale } from "@/lib/i18n/locale-provider"
import { LOGO_TYPES, MAX_LOGO_BYTES, type Account, type LogoType } from "@/lib/types"

/** File → base64 (without the `data:…;base64,` prefix). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "")
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Upload, replace or remove a workspace's logo (shown in its sidebar). */
export function LogoField({ account }: { account: Account }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const setLogo = useSetAccountLogo()
  const input = React.useRef<HTMLInputElement>(null)
  const [localError, setLocalError] = React.useState<AppError | null>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const error = localError ?? setLogo.error

  async function upload(file: File) {
    setLocalError(null)
    setLogo.reset()
    if (!LOGO_TYPES.includes(file.type as LogoType))
      return setLocalError(new AppError("logoInvalid"))
    if (file.size > MAX_LOGO_BYTES) return setLocalError(new AppError("logoTooLarge"))
    setLogo.mutate(
      { id: account.id, logo: { contentType: file.type as LogoType, data: await toBase64(file) } },
      { onSuccess: () => toastManager.add({ type: "success", title: t("platform.logoSaved") }) },
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="eyebrow">{t("platform.logo")}</p>
        <p className="mt-1 text-xs text-foreground-muted">{t("platform.logoHint")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid h-16 w-48 shrink-0 place-items-center rounded-md border bg-surface-muted px-3">
          {account.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- versioned, private, already sized
            <img
              src={account.logoUrl}
              alt={account.name}
              className="max-h-10 max-w-full object-contain"
              data-testid="logo-preview"
            />
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <ImageIcon className="size-4" />
              {t("platform.noLogo")}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={setLogo.isPending}
            onClick={() => input.current?.click()}
          >
            <UploadIcon />
            {account.logoUrl ? t("platform.replaceLogo") : t("platform.uploadLogo")}
          </Button>
          {account.logoUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={setLogo.isPending}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2Icon />
              {t("platform.removeLogo")}
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept={LOGO_TYPES.join(",")}
          className="hidden"
          data-testid="logo-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = "" // allow picking the same file again
            if (file) void upload(file)
          }}
        />
      </div>
      <FormError message={error ? errorMessage(error) : null} />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("platform.removeLogoTitle")}
        description={t("platform.removeLogoBody", { workspace: account.name })}
        confirmLabel={t("platform.removeLogo")}
        onConfirm={async () => {
          await setLogo.mutateAsync({ id: account.id, logo: null })
          toastManager.add({ type: "success", title: t("platform.logoRemoved") })
        }}
      />
    </div>
  )
}
