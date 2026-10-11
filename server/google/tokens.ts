/**
 * Secrets at rest (Google tokens, secrets saved in Platform → Settings):
 * AES-GCM with the ENCRYPTION_KEY secret (32 bytes, base64), stored as
 * `v1.<iv>.<ciphertext>`. Plus PKCE and a constant-time
 * compare for OAuth state and webhook channel tokens.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const keys = new Map<string, Promise<CryptoKey>>()

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function importKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    const raw = fromBase64(secret)
    if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64")
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])
    keys.set(secret, key)
  }
  return key
}

export async function encryptToken(secret: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importKey(secret),
    encoder.encode(token),
  )
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(data))}`
}

export async function decryptToken(secret: string, stored: string): Promise<string> {
  const [version, iv, data] = stored.split(".")
  if (version !== "v1" || !iv || !data) throw new Error("Unknown token format")
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    await importKey(secret),
    fromBase64(data),
  )
  return decoder.decode(plain)
}

export function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** PKCE (RFC 7636) verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

export function sameSecret(a: string, b: string): boolean {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
