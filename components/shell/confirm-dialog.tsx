"use client"

import { TriangleAlertIcon } from "lucide-react"
import * as React from "react"
import { FormError } from "@/components/shell/form-row"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import { useLocale } from "@/lib/i18n/locale-provider"

/**
 * Warning modal in front of a destructive action. `onConfirm` returns a
 * promise: the dialog stays open (showing the error) if it fails and closes
 * when it succeeds.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)

  function close(next: boolean) {
    if (pending) return // don't drop the dialog mid-action
    if (!next) setError(null)
    onOpenChange(next)
  }

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      setPending(false)
      onOpenChange(false)
    } catch (caught) {
      setPending(false)
      setError(caught)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-md" data-testid="confirm-dialog">
        <DialogHeader>
          <DialogIcon severity="destructive">
            <TriangleAlertIcon />
          </DialogIcon>
          <DialogTitle className="font-display text-xl">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          <FormError message={error ? errorMessage(error) : null} />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" loading={pending} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
