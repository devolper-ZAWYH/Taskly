/**
 * Builds a plain-text + HTML email (RFC 5322 / MIME). Pure, so `node --test`
 * can run it directly. Non-ASCII headers (Arabic subjects and names) become
 * RFC 2047 encoded-words; bodies are UTF-8, base64.
 */

export type Address = { name?: string; email: string }

export type MailMessage = {
  from: Address
  to: Address
  subject: string
  text: string
  html: string
  /** Extra headers, e.g. `Auto-Submitted`. */
  headers?: Record<string, string>
}

const CRLF = "\r\n"
const encoder = new TextEncoder()

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Base64 body, wrapped at 76 characters per line. */
function base64Body(text: string): string {
  return (base64(encoder.encode(text)).match(/.{1,76}/g) ?? []).join(CRLF)
}

// Printable ASCII only; anything else (or a header that could inject lines) gets encoded.
const SAFE_HEADER = /^[\x20-\x7e]*$/

/**
 * A header value as RFC 2047 encoded-words when it isn't plain ASCII. Each
 * word stays under 75 characters and never splits a character.
 */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ")
  if (SAFE_HEADER.test(clean)) return clean
  const words: string[] = []
  let chunk = ""
  for (const char of clean) {
    // 45 bytes of UTF-8 → 60 base64 characters, plus the 12 of "=?UTF-8?B??=".
    if (encoder.encode(chunk + char).length > 45) {
      words.push(chunk)
      chunk = ""
    }
    chunk += char
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`).join(`${CRLF} `)
}

export function formatAddress(address: Address): string {
  const email = address.email.replace(/[\r\n<>]/g, "")
  if (!address.name) return `<${email}>`
  const name = SAFE_HEADER.test(address.name)
    ? `"${address.name.replace(/["\\\r\n]/g, "")}"`
    : encodeHeader(address.name)
  return `${name} <${email}>`
}

/** The full message, CRLF line endings, ready for SMTP DATA (before dot-stuffing). */
export function buildMessage(
  message: MailMessage,
  options: { date?: Date; messageId?: string; boundary?: string } = {},
): string {
  const date = options.date ?? new Date()
  const domain = message.from.email.split("@")[1] ?? "localhost"
  const messageId = options.messageId ?? `<${crypto.randomUUID()}@${domain}>`
  const boundary = options.boundary ?? `=_taskly_${crypto.randomUUID().replace(/-/g, "")}`
  const headers: [string, string][] = [
    ["From", formatAddress(message.from)],
    ["To", formatAddress(message.to)],
    ["Subject", encodeHeader(message.subject)],
    ["Date", date.toUTCString().replace("GMT", "+0000")],
    ["Message-ID", messageId],
    ["MIME-Version", "1.0"],
    ["Content-Type", `multipart/alternative; boundary="${boundary}"`],
    ...Object.entries(message.headers ?? {}).map(
      ([name, value]): [string, string] => [name, encodeHeader(value)],
    ),
  ]
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(body),
    ].join(CRLF)
  return [
    ...headers.map(([name, value]) => `${name}: ${value}`),
    "",
    part("text/plain", message.text),
    part("text/html", message.html),
    `--${boundary}--`,
    "",
  ].join(CRLF)
}

/** SMTP DATA transparency: a line starting with "." gets another one. */
export function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, "$1..")
}
