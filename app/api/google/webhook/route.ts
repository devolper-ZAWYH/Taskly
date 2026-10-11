import { first } from "@/server/db"
import { enqueue } from "@/server/google/queue"
import { sameSecret } from "@/server/google/tokens"
import { requestContext } from "@/server/request"

/**
 * POST /api/google/webhook — Google Calendar push notifications for the
 * "Taskly · <Workspace>" calendars. The notification carries no data; it only
 * says "something changed", so we queue a pull of that calendar.
 * Always 200: Google retries anything else.
 */
export async function POST(request: Request) {
  const channelId = request.headers.get("x-goog-channel-id") ?? ""
  const token = request.headers.get("x-goog-channel-token") ?? ""
  const state = request.headers.get("x-goog-resource-state")
  if (!channelId || state === "sync") return new Response(null, { status: 200 })

  const ctx = await requestContext(request)
  const row = await first<{ user_id: string; google_id: string; channel_token: string | null }>(
    ctx.db,
    `SELECT user_id, google_id, channel_token FROM google_containers
     WHERE channel_id = ? AND kind = 'calendar' AND account_id IS NOT NULL`,
    channelId,
  )
  if (row?.channel_token && sameSecret(token, row.channel_token)) {
    await enqueue(ctx, [{ kind: "pull", userId: row.user_id, entityId: `calendar:${row.google_id}` }])
  }
  return new Response(null, { status: 200 })
}
