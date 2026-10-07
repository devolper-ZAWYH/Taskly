import { cookies } from "next/headers"
import { SESSION_COOKIE, type Ctx } from "@/server/context"
import { getCloudflareContext } from "@opennextjs/cloudflare"

/** Build the per-request context (database + session cookie) for a route handler. */
export async function requestContext(request: Request): Promise<Ctx> {
  const jar = await cookies()
  const secure = new URL(request.url).protocol === "https:"
  const { env, ctx } = getCloudflareContext()
  return {
    db: env.DB,
    env,
    waitUntil: (promise) => ctx.waitUntil(promise),
    token: jar.get(SESSION_COOKIE)?.value ?? null,
    setSessionCookie: (token, expires) =>
      jar.set(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", expires }),
    clearSessionCookie: () => jar.delete(SESSION_COOKIE),
  }
}
