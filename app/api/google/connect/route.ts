import { cookies } from "next/headers"
import { currentUser } from "@/server/context"
import { newSessionToken } from "@/server/crypto"
import { googleConfigured, OAUTH_COOKIE } from "@/server/google/config"
import { consentUrl } from "@/server/google/oauth"
import { getConnection } from "@/server/google/store"
import { pkcePair } from "@/server/google/tokens"
import { requestContext } from "@/server/request"

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

/**
 * GET /api/google/connect — sends the signed-in person to Google's consent
 * screen. Google returns them to /api/google/callback.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin
  const ctx = await requestContext(request)
  const me = await currentUser(ctx)
  if (!me) return redirect(`${origin}/login`)
  if (!googleConfigured(ctx.env)) return redirect(`${origin}/settings?google=error&reason=unconfigured`)

  const state = newSessionToken()
  const { verifier, challenge } = await pkcePair()
  const jar = await cookies()
  jar.set(OAUTH_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax", // sent on Google's top-level redirect back to us
    path: "/api/google",
    maxAge: 600,
  })
  // Reconnecting: suggest the account they used before.
  const previous = await getConnection(ctx.db, me.id)
  return redirect(
    consentUrl(ctx.env, {
      redirectUri: `${origin}/api/google/callback`,
      state,
      challenge,
      loginHint: previous?.google_email,
    }),
  )
}
