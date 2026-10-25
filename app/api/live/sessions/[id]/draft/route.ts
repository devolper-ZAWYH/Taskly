import { requestContext } from "@/server/request"
import {
  authenticateDeviceToken,
  postLiveDraft,
  type DeviceAuth,
} from "@/server/services/live"
import { enforceLiveRateLimit } from "@/server/live/rate-limit"
import { liveErrorResponse } from "@/server/live/http"

/**
 * POST /api/live/sessions/[id]/draft — the desktop engine posts the summary
 * draft it wrote with its own model (the `on_device` path) for the review
 * card. Reviewed sessions refuse; a regenerate replaces the previous draft.
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
    const { draft } = await postLiveDraft(ctx, device, id, await request.json().catch(() => null))
    return Response.json({ draft })
  } catch (error) {
    return liveErrorResponse("live draft", error, {
      userId: device?.userId,
      sessionId: typeof id === "string" ? id.slice(0, 100) : undefined,
    })
  }
}
