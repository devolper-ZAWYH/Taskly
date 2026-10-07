import { currentUser } from "@/server/context"
import { first } from "@/server/db"
import { requestContext } from "@/server/request"

/**
 * GET /api/avatar/<userId>?v=<version> — a profile picture, for the person
 * themselves, platform operators, and anyone sharing a workspace with them.
 */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params
  const ctx = await requestContext(request)
  const viewer = await currentUser(ctx)
  if (!viewer) return new Response(null, { status: 401 })

  const avatar = await first<{ content_type: string; data: string }>(
    ctx.db,
    `SELECT a.content_type, a.data FROM user_avatars a
     WHERE a.user_id = ?
       AND (a.user_id = ? OR ? OR EXISTS (
         SELECT 1 FROM memberships mine JOIN memberships theirs ON theirs.account_id = mine.account_id
         WHERE mine.user_id = ? AND theirs.user_id = a.user_id))`,
    userId,
    viewer.id,
    viewer.isOperator ? 1 : 0,
    viewer.id,
  )
  if (!avatar) return new Response(null, { status: 404 })

  const bytes = Uint8Array.from(atob(avatar.data), (c) => c.charCodeAt(0))
  return new Response(bytes, {
    headers: {
      "content-type": avatar.content_type,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  })
}
