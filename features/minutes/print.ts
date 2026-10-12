/**
 * Print one set of minutes (or save it as PDF from the print dialog). The
 * text goes into a hidden frame of its own, so the app around it isn't printed.
 */
export function printMinutes({
  heading,
  title,
  meta,
  body,
  lang,
  dir,
}: {
  /** e.g. "Minutes of meeting" */
  heading: string
  title: string
  /** Date, author and the like, one line. */
  meta: string
  body: string
  lang: string
  dir: "ltr" | "rtl"
}): void {
  const frame = document.createElement("iframe")
  frame.setAttribute("aria-hidden", "true")
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;inset-inline-start:-9999px"
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) {
    frame.remove()
    return
  }
  doc.open()
  doc.write(`<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 12pt/1.6 system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; color: #111; margin: 2cm; }
  .eyebrow { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #666; }
  h1 { font-size: 18pt; margin: .25em 0; unicode-bidi: plaintext; }
  .meta { color: #444; margin-bottom: 1.5em; padding-bottom: 1em; border-bottom: 1px solid #ccc; }
  .body { white-space: pre-wrap; unicode-bidi: plaintext; }
</style>
</head>
<body>
  <div class="eyebrow">${escapeHtml(heading)}</div>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
  <div class="body">${escapeHtml(body)}</div>
</body>
</html>`)
  doc.close()
  const cleanup = () => frame.remove()
  win.addEventListener("afterprint", () => setTimeout(cleanup, 0))
  // Give the frame a moment to lay out before printing.
  setTimeout(() => {
    win.focus()
    win.print()
    // Some browsers never fire afterprint for frames.
    setTimeout(cleanup, 60_000)
  }, 50)
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )
}
