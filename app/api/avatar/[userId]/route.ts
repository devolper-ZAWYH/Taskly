import { currentUser } from "@/server/context"
import { first } from "@/server/db"
import { photoLinkViewer } from "@/server/mcp/photos"
import { requestContext } from "@/server/request"

/**
 * GET /api/avatar/<userId>?v=<version> — a profile picture, for the person
 * themselves, platform operators, and anyone sharing a workspace with them.
 * Claude's cards, which have no session, pass a photo link token (`pt`)
 * instead and see what its owner would see (server/mcp/photos.ts).
 */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params
  const ctx = await requestContext(request)
  const user = await currentUser(ctx)
  const viewer = user
    ? { id: user.id, isOperator: user.isOperator }
    : await photoLinkViewer(ctx, new URL(request.url).searchParams.get("pt")).then((id) =>
        id ? { id, isOperator: false } : null,
      )
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
