/**
 * The apps that may ask for access. Claude identifies itself with a Client ID
 * Metadata Document: its client_id is an https URL, which we fetch (carefully)
 * and cache for a day. Clients that predate that register through
 * /oauth/register (Dynamic Client Registration, RFC 7591).
 */
import type { Ctx } from "@/server/context"
import { newId } from "@/server/crypto"
import { first, nowIso, run } from "@/server/db"
import {
  fetchableHost,
  isClientDocumentUrl,
  isLoopbackRedirect,
  isPrivateAddress,
  readClientDocument,
  redirectAllowed,
} from "@/server/mcp/oauth-rules"
import { ON_NODE } from "@/server/runtime"

export type OAuthClient = {
  clientId: string
  kind: "cimd" | "dcr"
  /** What the app calls itself; shown next to `host`, never instead of it. */
  name: string
  /** Where it really lives: the document's host, or where it sends people back to. */
  host: string
  redirectUris: string[]
}

type ClientRow = {
  client_id: string
  kind: "cimd" | "dcr"
  name: string
  redirect_uris: string
  fetched_at: string | null
}

const DOCUMENT_MAX_AGE_MS = 24 * 3_600_000
const DOCUMENT_MAX_BYTES = 10_240
const FETCH_TIMEOUT_MS = 5_000

function toClient(row: ClientRow): OAuthClient {
  const redirectUris = JSON.parse(row.redirect_uris) as string[]
  return {
    clientId: row.client_id,
    kind: row.kind,
    name: row.name,
    host: row.kind === "cimd" ? new URL(row.client_id).host : hostOfRedirects(redirectUris),
    redirectUris,
  }
}

function hostOfRedirects(uris: string[]): string {
  const first = uris[0]
  if (!first) return ""
  return isLoopbackRedirect(first) ? "localhost" : new URL(first).host
}

/** The client behind `clientId`, or null if it doesn't exist or can't be used. */
export async function resolveClient(ctx: Ctx, clientId: string): Promise<OAuthClient | null> {
  const row = await first<ClientRow>(ctx.db, "SELECT * FROM oauth_clients WHERE client_id = ?", clientId)
  if (!isClientDocumentUrl(clientId)) return row?.kind === "dcr" ? toClient(row) : null

  const fresh =
    row?.fetched_at && Date.now() - new Date(row.fetched_at).getTime() < DOCUMENT_MAX_AGE_MS
  if (row && fresh) return toClient(row)
  try {
    const document = readClientDocument(await fetchDocument(clientId), clientId)
    if (typeof document === "string") throw new Error(document)
    const now = nowIso()
    await run(
      ctx.db,
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, fetched_at, created_at)
       VALUES (?, 'cimd', ?, ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET
         name = excluded.name, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`,
      clientId,
      document.name,
      JSON.stringify(document.redirectUris),
      now,
      now,
    )
    return toClient({
      client_id: clientId,
      kind: "cimd",
      name: document.name,
      redirect_uris: JSON.stringify(document.redirectUris),
      fetched_at: now,
    })
  } catch (error) {
    console.error(`client metadata ${clientId} unusable`, error)
    // Keep using yesterday's copy if the document is briefly unreachable.
    return row ? toClient(row) : null
  }
}

/**
 * Fetch a client document without letting it reach our own network: public
 * names only, no redirects, a short timeout and a small size cap. On
 * Cloudflare `global_fetch_strictly_public` already keeps fetches public; on
 * a Node server we resolve the name first and refuse private addresses.
 */
async function fetchDocument(url: string): Promise<unknown> {
  const target = new URL(url)
  if (!fetchableHost(target.hostname)) throw new Error("host not allowed")
  if (ON_NODE) await assertPublicDns(target.hostname)
  const response = await fetch(target, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return JSON.parse(await readLimited(response, DOCUMENT_MAX_BYTES))
}

async function assertPublicDns(hostname: string): Promise<void> {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule
  const dns = getBuiltin?.("node:dns") as
    | { promises: { lookup: (host: string, options: { all: true }) => Promise<{ address: string }[]> } }
    | undefined
  if (!dns) throw new Error("DNS lookup unavailable")
  const addresses = await dns.promises.lookup(hostname, { all: true })
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("resolves to a private address")
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error("document too large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes)
}

/** Note that a client was just used (sign-in or token), for cleaning up unused registrations later. */
export async function touchClient(ctx: Ctx, clientId: string): Promise<void> {
  await run(ctx.db, "UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?", nowIso(), clientId)
}

export type Registration =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string; description: string }

/**
 * Dynamic Client Registration (RFC 7591). Every client is public (PKCE, no
 * secret), and may only send people back to Claude.
 */
export async function registerClient(ctx: Ctx, raw: unknown): Promise<Registration> {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris is required" }
  }
  const redirectUris = uris as string[]
  if (!redirectUris.every(redirectAllowed)) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: "Taskly only signs in to Claude: its apps' callback or a loopback address",
    }
  }
  const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 100) : ""
  const clientId = newId("dcr")
  const now = nowIso()
  await run(
    ctx.db,
    `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, created_at)
     VALUES (?, 'dcr', ?, ?, ?)`,
    clientId,
    name,
    JSON.stringify(redirectUris),
    now,
  )
  return {
    ok: true,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name || undefined,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  }
}
