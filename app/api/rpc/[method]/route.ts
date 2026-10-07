import { AppError } from "@/lib/api/core"
import { api } from "@/server/api"
import type { Ctx } from "@/server/context"
import { requestContext } from "@/server/request"

/**
 * Single JSON endpoint for the app: POST /api/rpc/<method> with `{ args }`.
 * Responds `{ data }`, or `{ error: <ErrorCode> }` with a 4xx status.
 */
export async function POST(request: Request, { params }: { params: Promise<{ method: string }> }) {
  const { method } = await params
  if (!Object.hasOwn(api, method)) return Response.json({ error: "notFound" }, { status: 404 })
  // JSON-only: a cross-site form can't send this without a CORS preflight.
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "badRequest" }, { status: 415 })
  }

  let args: unknown[]
  try {
    const body = (await request.json()) as { args?: unknown }
    if (!Array.isArray(body.args)) throw new Error("args")
    args = body.args
  } catch {
    return Response.json({ error: "badRequest" }, { status: 400 })
  }

  const ctx = await requestContext(request)

  try {
    const fn = api[method as keyof typeof api] as (ctx: Ctx, ...args: unknown[]) => Promise<unknown>
    const data = await fn(ctx, ...args)
    return Response.json({ data: data ?? null })
  } catch (error) {
    if (error instanceof AppError) {
      const status = error.code === "unauthorized" ? 401 : error.code === "forbidden" ? 403 : 400
      return Response.json({ error: error.code }, { status })
    }
    console.error(`rpc ${method} failed`, error)
    return Response.json({ error: "server" }, { status: 500 })
  }
}
