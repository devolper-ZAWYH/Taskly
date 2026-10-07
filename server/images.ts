/** Does the decoded file really look like the declared image type? */
export function looksLikeImage(type: string, bytes: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (type === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  if (type === "image/jpeg") return starts(0xff, 0xd8, 0xff)
  if (type === "image/webp") {
    const text = String.fromCharCode(...bytes.slice(0, 12))
    return text.startsWith("RIFF") && text.slice(8, 12) === "WEBP"
  }
  if (type === "image/svg+xml") {
    const head = new TextDecoder().decode(bytes.slice(0, 1024)).trimStart()
    return (head.startsWith("<svg") || head.startsWith("<?xml")) && head.includes("<svg")
  }
  return false
}

/** Decode base64 or return null. */
export function decodeBase64(data: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}
