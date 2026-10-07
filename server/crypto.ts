/**
 * Passwords and session tokens, using only Web Crypto (available in Workers
 * and Node). Password hashes are self-describing so the cost can be raised
 * later without breaking existing ones.
 */

// Workers' Web Crypto caps PBKDF2 at 100k iterations.
const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BYTES = 32

const encoder = new TextEncoder()

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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

async function pbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$")
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !hash) return false
  const actual = await pbkdf2(password, fromBase64(salt), Number(iterations))
  return timingSafeEqual(actual, fromBase64(hash))
}

/** Random, URL-safe session token for the cookie. */
export function newSessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/** What the sessions table stores instead of the token itself. */
export async function hashToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))))
}

/** Readable one-time password for a new account (12 chars from 55, ~69 bits). */
export function newTemporaryPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
