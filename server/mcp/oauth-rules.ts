/**
 * The pure rules of Taskly's OAuth server: PKCE, which redirects and scopes
 * are allowed, client metadata documents, and which hosts may be fetched. No
 * I/O and no runtime imports, so `node --test` runs it directly.
 */

/** What a connection may do. Phase 1 tools only read; writing comes with the commands. */
export const SCOPES = ["taskly.read", "taskly.write"] as const
export type Scope = (typeof SCOPES)[number]

/** Where the Claude apps (web, desktop, mobile, Cowork) send people back after signing in. */
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback"

export function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  return VERIFIER.test(verifier) && (await pkceChallenge(verifier)) === challenge
}

function parse(uri: string): URL | null {
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

/** An app on the person's own computer (Claude Code): http on localhost, any port. */
export function isLoopbackRedirect(uri: string): boolean {
  const url = parse(uri)
  return url !== null && url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)
}

/** Taskly only sends people back to Claude: the apps' callback, or a loopback address. */
export function redirectAllowed(uri: string): boolean {
  return uri === CLAUDE_REDIRECT || isLoopbackRedirect(uri)
}

/**
 * Whether `requested` is one of the client's registered redirects. Loopback
 * redirects may use any port (RFC 8252 §7.3); everything else must match exactly.
 */
export function redirectRegistered(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  if (!isLoopbackRedirect(requested)) return false
  const want = new URL(requested)
  return registered.some((uri) => {
    if (!isLoopbackRedirect(uri)) return false
    const have = new URL(uri)
    return (
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    )
  })
}

/**
 * The scopes to grant for a request: the supported ones it asked for, or all
 * of them when it asked for none. Null when it only asked for unknown ones.
 */
export function grantedScopes(raw: string | null | undefined): Scope[] | null {
  const asked = (raw ?? "").split(/\s+/).filter(Boolean)
  if (asked.length === 0) return [...SCOPES]
  const known = SCOPES.filter((scope) => asked.includes(scope))
  return known.length > 0 ? known : null
}

export type ClientDocument = { name: string; redirectUris: string[] }

/**
 * Check a Client ID Metadata Document fetched from `url` (its `client_id`).
 * Returns the client, or the reason it can't be used.
 */
export function readClientDocument(doc: unknown, url: string): ClientDocument | string {
  if (typeof doc !== "object" || doc === null) return "not a JSON object"
  const d = doc as Record<string, unknown>
  if (d.client_id !== url) return "client_id does not match the document URL"
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0) return "no redirect_uris"
  const redirectUris = d.redirect_uris.filter((uri): uri is string => typeof uri === "string")
  if (redirectUris.length !== d.redirect_uris.length || redirectUris.some((uri) => !parse(uri))) {
    return "invalid redirect_uris"
  }
  const method = d.token_endpoint_auth_method
  if (method !== undefined && method !== "none") return `unsupported auth method ${String(method)}`
  const name = typeof d.client_name === "string" ? d.client_name.trim().slice(0, 100) : ""
  return { name, redirectUris }
}

/** A client_id that names a metadata document: an https URL with a path. */
export function isClientDocumentUrl(clientId: string): boolean {
  const url = parse(clientId)
  return url !== null && url.protocol === "https:" && url.pathname !== "/" && !url.hash
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Loopback, private, link-local, shared, reserved or multicast: never fetched. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = IPV4.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "")
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
  if (mapped) return isPrivateAddress(mapped[1])
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) || // unique local fc00::/7
    /^fe[89ab]/.test(v6) || // link-local fe80::/10
    /^ff/.test(v6) // multicast
  )
}

/** Hosts a client document may be fetched from: public DNS names, never addresses or local names. */
export function fetchableHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) return false
  if (!host.includes(".")) return false
  return !/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host)
}
