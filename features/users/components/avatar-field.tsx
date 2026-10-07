"use client"

import { useQueryClient } from "@tanstack/react-query"
import { CameraIcon, Trash2Icon } from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError } from "@/components/shell/form-row"
import { UserAvatar } from "@/components/shell/user-avatar"
import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import { ME_KEY, useCurrentUser } from "@/features/auth/use-auth"
import { useInvalidateMembership } from "@/features/users/hooks/use-users"
import { setMyAvatar } from "@/lib/api/auth"
import { AppError } from "@/lib/api/core"
import { useLocale } from "@/lib/i18n/locale-provider"
import { resizeToSquare } from "@/lib/resize-image"

/** Add, change or remove your own profile picture. */
export function AvatarField(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const me = useCurrentUser()
  const queryClient = useQueryClient()
  const invalidatePeople = useInvalidateMembership()
  const input = React.useRef<HTMLInputElement>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)

  async function save(photo: Parameters<typeof setMyAvatar>[0]) {
    const user = await setMyAvatar(photo)
    queryClient.setQueryData(ME_KEY, user)
    void invalidatePeople()
  }

  async function upload(file: File) {
    setError(null)
    if (!file.type.startsWith("image/")) return setError(new AppError("avatarInvalid"))
    setPending(true)
    try {
      await save(await resizeToSquare(file))
      toastManager.add({ type: "success", title: t("settings.photoSaved") })
    } catch (caught) {
      // Undecodable files (e.g. HEIC in some browsers) fail in the resizer.
      setError(caught instanceof AppError ? caught : new AppError("avatarInvalid"))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <UserAvatar name={me.name} src={me.avatarUrl} className="size-16 text-lg ring-0" />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={pending}
            onClick={() => input.current?.click()}
          >
            <CameraIcon />
            {me.avatarUrl ? t("settings.changePhoto") : t("settings.uploadPhoto")}
          </Button>
          {me.avatarUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2Icon />
              {t("settings.removePhoto")}
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          data-testid="avatar-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) void upload(file)
          }}
        />
      </div>
      <p className="text-xs text-foreground-muted">{t("settings.photoHint")}</p>
      <FormError message={error ? errorMessage(error) : null} />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("settings.removePhotoTitle")}
        description={t("settings.removePhotoBody")}
        confirmLabel={t("settings.removePhoto")}
        onConfirm={async () => {
          await save(null)
          toastManager.add({ type: "success", title: t("settings.photoRemoved") })
        }}
      />
    </div>
  )
}
