import { requestContext } from "@/server/request"
import {
  authenticateDeviceToken,
  endLiveSession,
  type DeviceAuth,
} from "@/server/services/live"
import { enforceLiveRateLimit } from "@/server/live/rate-limit"
import { liveErrorResponse } from "@/server/live/http"

/**
 * POST /api/live/sessions/[id]/end — the desktop engine stops recording.
 * Ending an already-ended session is a no-op returning the session.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const ctx = await requestContext(request)
  let device: DeviceAuth | undefined
  try {
    device = await authenticateDeviceToken(ctx, request)
    enforceLiveRateLimit(device.userId)
    const session = await endLiveSession(ctx, device, id)
    return Response.json({ session })
  } catch (error) {
    return liveErrorResponse("live session end", error, {
      userId: device?.userId,
      sessionId: typeof id === "string" ? id.slice(0, 100) : undefined,
    })
  }
}
