import { AppError } from "@/lib/api/core"
import { requestContext } from "@/server/request"
import { startLiveSession, authenticateDeviceToken } from "@/server/services/live"
import { enforceLiveRateLimit } from "@/server/live/rate-limit"
import { liveErrorResponse } from "@/server/live/http"

/**
 * POST /api/live/sessions — the desktop engine starts a recording
 * (`Authorization: Bearer <device token>`). Body: `{ meeting_title,
 * meeting_date, meeting_id? }`; the `meeting_id` claim copies the meeting's
 * own title and date. Errors follow `{ error: <code> }` with the contract's
 * statuses; logs carry ids only, never the transcript.
 */
export async function POST(request: Request) {
  const ctx = await requestContext(request)
  let userId: string | undefined
  try {
    const device = await authenticateDeviceToken(ctx, request)
    userId = device.userId
    enforceLiveRateLimit(device.userId)
    // A body that isn't JSON is the contract's 400, not a server failure.
    const body = await request.json().catch(() => {
      throw new AppError("badRequest")
    })
    const session = await startLiveSession(ctx, device, body)
    return Response.json({ session })
  } catch (error) {
    return liveErrorResponse("live session start", error, { userId })
  }
}
