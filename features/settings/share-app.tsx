"use client"

import { CheckIcon, CopyIcon, MailIcon, MessageCircleIcon, Share2Icon } from "lucide-react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLocale } from "@/lib/i18n/locale-provider"

/**
 * Share Taskly: the native share sheet where the browser has one (phones,
 * Safari, Edge, Chrome on Windows/macOS), plus copy link, WhatsApp, email and
 * a QR code to scan from another phone.
 */
export function ShareApp(): React.ReactElement {
  const { t } = useLocale()
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/`
  const message = t("share.message")
  const [copied, setCopied] = React.useState(false)
  const [qr, setQr] = React.useState<string | null>(null)
  const canShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    (navigator.canShare?.({ url }) ?? true)

  React.useEffect(() => {
    if (!url) return
    let cancelled = false
    // Loaded only here, so the QR library stays out of every other page.
    void import("qrcode").then((QRCode) =>
      QRCode.toString(url, {
        type: "svg",
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#1c1a17", light: "#ffffff" },
      }).then((svg) => {
        if (!cancelled) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      }),
    )
    return () => {
      cancelled = true
    }
  }, [url])

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked: the link is selectable in the field.
    }
  }

  async function share() {
    try {
      await navigator.share({ title: "Taskly", text: message, url })
    } catch {
      // Dismissed by the person, or not allowed here — nothing to do.
    }
  }

  const text = `${message} ${url}`
  return (
    <div className="flex flex-col gap-5" data-testid="share-app">
      <div className="flex gap-2">
        <Input
          value={url}
          readOnly
          dir="ltr"
          aria-label={t("share.link")}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t("share.copied") : t("share.copy")}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {canShare ? (
          <Button type="button" onClick={() => void share()}>
            <Share2Icon />
            {t("share.share")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          render={
            <a
              href={`https://wa.me/?text=${encodeURIComponent(text)}`}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <MessageCircleIcon />
          WhatsApp
        </Button>
        <Button
          type="button"
          variant="outline"
          render={
            <a
              href={`mailto:?subject=${encodeURIComponent(t("share.emailSubject"))}&body=${encodeURIComponent(text)}`}
            />
          }
        >
          <MailIcon />
          {t("share.email")}
        </Button>
      </div>

      <div className="flex items-center gap-4 rounded-md border p-4">
        <div className="grid size-28 shrink-0 place-items-center rounded-md border bg-white p-1.5">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- generated QR code
            <img src={qr} alt={t("share.qrAlt")} className="size-full" data-testid="share-qr" />
          ) : null}
        </div>
        <div>
          <p className="text-sm font-medium">{t("share.qrTitle")}</p>
          <p className="mt-1 text-xs text-foreground-muted">{t("share.qrHint")}</p>
        </div>
      </div>
    </div>
  )
}
