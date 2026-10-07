/**
 * Web Push without payloads: we only wake the device; its service worker then
 * fetches the newest notification over the authenticated API. That keeps
 * message text out of the push services and avoids payload encryption.
 * Requests are signed with VAPID (ES256 JWT) using Web Crypto.
 */

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64 + "===".slice((base64.length + 3) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

export type VapidKeys = { publicKey: string; privateKey: string; subject: string }

async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = fromBase64url(keys.publicKey) // 0x04 || x || y
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: base64url(pub.slice(1, 33)),
      y: base64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
}

async function vapidJwt(audience: string, keys: VapidKeys, key: CryptoKey): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = base64url(
    encoder.encode(
      JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: keys.subject }),
    ),
  )
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${claims}`),
  )
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`
}

/**
 * Ping each endpoint. Returns the endpoints the push service says are gone
 * (404/410), so the caller can forget them.
 */
export async function sendPushes(endpoints: string[], keys: VapidKeys): Promise<string[]> {
  if (endpoints.length === 0) return []
  const key = await signingKey(keys)
  const jwts = new Map<string, string>()
  const gone: string[] = []
  await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const audience = new URL(endpoint).origin
        if (!jwts.has(audience)) jwts.set(audience, await vapidJwt(audience, keys, key))
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            TTL: String(24 * 3600),
            Urgency: "normal",
            Authorization: `vapid t=${jwts.get(audience)}, k=${keys.publicKey}`,
            "Content-Length": "0",
          },
        })
        if (response.status === 404 || response.status === 410) gone.push(endpoint)
      } catch (error) {
        console.error("push failed", error)
      }
    }),
  )
  return gone
}
