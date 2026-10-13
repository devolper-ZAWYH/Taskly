/**
 * Small HTTP helpers for the OAuth endpoints. They answer other servers
 * (Claude's) and browser-based MCP tools, never with cookies, so CORS is open.
 */

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...CORS, "cache-control": "no-store", ...headers },
  })
}

/** RFC 6749 §5.2 error body. */
export function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status)
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

/** Form fields (token, revoke) or a JSON object (register); unknown shapes read as empty. */
export async function formFields(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? ""
  if (type.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await request.text())
  }
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(body ?? {})) {
      if (typeof value === "string") params.set(key, value)
    }
    return params
  }
  return new URLSearchParams()
}
