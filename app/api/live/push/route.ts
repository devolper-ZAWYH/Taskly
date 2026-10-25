import { AppError } from "@/lib/api/core"
import { requestContext } from "@/server/request"
import { authenticateDeviceToken, pushLiveSegments } from "@/server/services/live"
import { enforceLiveRateLimit } from "@/server/live/rate-limit"
import { liveErrorResponse } from "@/server/live/http"

/**
 * POST /api/live/push — the desktop engine sends a batch of up to 200
 * segments, idempotent per (session, seq): repeats are ACK'd, never an
 * error. Responds `{ accepted, last_seq }` per the device contract; logs
 * carry ids only, never segment text.
 */
export async function POST(request: Request) {
  const ctx = await requestContext(request)
  let userId: string | undefined
  let sessionId: string | undefined
  try {
    const device = await authenticateDeviceToken(ctx, request)
    userId = device.userId
    enforceLiveRateLimit(device.userId)
    // The id (never the transcript) may accompany a failure log.
    // A body that isn't JSON is the contract's 400, not a server failure.
    const body = (await request.json().catch(() => {
      throw new AppError("badRequest")
    })) as { session_id?: unknown }
    if (typeof body?.session_id === "string") sessionId = body.session_id.slice(0, 100)
    const { accepted, last_seq } = await pushLiveSegments(ctx, device, body)
    return Response.json({ accepted, last_seq })
  } catch (error) {
    return liveErrorResponse("live push", error, { userId, sessionId })
  }
}
