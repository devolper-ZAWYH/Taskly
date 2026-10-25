/**
 * Error responses for the /api/live/* routes, shaped like the rest of the
 * app (`{ error: <ErrorCode> }`) but keeping the contract's status codes:
 * 401 unknown token, 403 revoked / person deactivated / someone else's
 * session, 404 unknown or ended session, 429 over the rate limit.
 *
 * Logs carry ids only — never segment text, never titles.
 */
import { AppError, type ErrorCode } from "@/lib/api/core"

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  liveSessionNotFound: 404,
  meetingNotFound: 404,
  tooManyAttempts: 429,
}

export function liveErrorStatus(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 400
}

/** One catch block for the three routes. */
export function liveErrorResponse(
  scope: string,
  error: unknown,
  ids: { userId?: string; sessionId?: string },
): Response {
  if (error instanceof AppError) {
    return Response.json({ error: error.code }, { status: liveErrorStatus(error.code) })
  }
  console.error(`${scope} failed`, { ...ids, error: String(error) })
  return Response.json({ error: "server" }, { status: 500 })
}
