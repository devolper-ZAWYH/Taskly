import { hashToken } from "@/server/crypto"
import { runJobs, systemContext, type JobKind } from "@/server/jobs"
import { platform } from "@/server/runtime"

/**
 * POST /api/cron?job=frequent|hourly — the scheduled work, for servers without
 * Cron Triggers (cPanel): a cron job calls it every 5 minutes and every hour
 * with `Authorization: Bearer <CRON_SECRET>`. Off (404) unless CRON_SECRET is set.
 */
export async function POST(request: Request) {
  const { env, waitUntil } = platform()
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET
  if (!secret) return new Response(null, { status: 404 })
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
  // Compared as hashes, so the time taken says nothing about the secret.
  if (!given || (await hashToken(given)) !== (await hashToken(secret))) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const job = new URL(request.url).searchParams.get("job")
  if (job !== "frequent" && job !== "hourly") {
    return Response.json({ error: "badRequest" }, { status: 400 })
  }
  try {
    const summary = await runJobs(systemContext(env, waitUntil), job as JobKind, new Date())
    console.log(summary)
    return Response.json({ data: summary })
  } catch (error) {
    console.error(`cron ${job} failed`, error)
    return Response.json({ error: "server" }, { status: 500 })
  }
}
