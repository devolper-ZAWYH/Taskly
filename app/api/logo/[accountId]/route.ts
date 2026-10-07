import { currentUser } from "@/server/context"
import { first } from "@/server/db"
import { requestContext } from "@/server/request"

/**
 * GET /api/logo/<accountId>?v=<version> — the workspace logo, for people who
 * can open that workspace. URLs are versioned, so browsers cache them for good.
 */
export async function GET(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params
  const ctx = await requestContext(request)
  const user = await currentUser(ctx)
  if (!user) return new Response(null, { status: 401 })

  const logo = await first<{ content_type: string; data: string }>(
    ctx.db,
    `SELECT l.content_type, l.data FROM account_logos l
     WHERE l.account_id = ?
       AND (? OR EXISTS (SELECT 1 FROM memberships ms WHERE ms.account_id = l.account_id AND ms.user_id = ?))`,
    accountId,
    user.isOperator ? 1 : 0,
    user.id,
  )
  if (!logo) return new Response(null, { status: 404 })

  const bytes = Uint8Array.from(atob(logo.data), (c) => c.charCodeAt(0))
  return new Response(bytes, {
    headers: {
      "content-type": logo.content_type,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      // An SVG opened directly must never run scripts or load anything.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  })
}
