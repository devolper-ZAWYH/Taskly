import { cookies } from "next/headers"
import { SESSION_COOKIE, type Ctx } from "@/server/context"
import { ON_NODE, platform } from "@/server/runtime"

/** Build the per-request context (database + session cookie) for a route handler. */
export async function requestContext(request: Request): Promise<Ctx> {
  const jar = await cookies()
  const { env, waitUntil } = platform()
  const secure = isHttps(request)
  return {
    db: env.DB,
    env,
    waitUntil,
    token: jar.get(SESSION_COOKIE)?.value ?? null,
    ip: clientIp(request),
    setSessionCookie: (token, expires) =>
      jar.set(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", expires }),
    clearSessionCookie: () => jar.delete(SESSION_COOKIE),
  }
}

/** Behind cPanel's web server the app itself is reached over http; the proxy says what the visitor used. */
function isHttps(request: Request): boolean {
  if (ON_NODE) {
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    if (forwarded) return forwarded === "https"
  }
  return new URL(request.url).protocol === "https:"
}

/**
 * The visitor's address (sign-in throttling). Cloudflare sets CF-Connecting-IP.
 * On a Node server, the last X-Forwarded-For entry is the one the server's own
 * proxy added (earlier ones come from the visitor and can be made up). Unknown
 * is undefined, so nobody shares a limit by accident.
 */
function clientIp(request: Request): string | undefined {
  if (ON_NODE) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    return forwarded || request.headers.get("x-real-ip")?.trim() || undefined
  }
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  )
}
