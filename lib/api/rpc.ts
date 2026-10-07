import { AppError, type ErrorCode } from "@/lib/api/core"
import type { Api, ApiMethod } from "@/server/api"

/** Arguments of a server function, minus the request context it receives. */
type ClientArgs<M extends ApiMethod> = Api[M] extends (ctx: never, ...args: infer A) => unknown
  ? A
  : never
type ClientResult<M extends ApiMethod> = Awaited<ReturnType<Api[M]>>

/** Call a server function by name; failures come back as `AppError`. */
export async function rpc<M extends ApiMethod>(
  method: M,
  ...args: ClientArgs<M>
): Promise<ClientResult<M>> {
  const response = await fetch(`/api/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
    credentials: "same-origin",
  })
  const body = (await response.json().catch(() => ({}))) as { data?: unknown; error?: string }
  if (!response.ok || body.error) {
    if (body.error && body.error !== "server") throw new AppError(body.error as ErrorCode)
    throw new Error(`Request failed (${response.status})`)
  }
  return body.data as ClientResult<M>
}
