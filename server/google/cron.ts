/**
 * The 5-minute Cron Trigger for Google sync: queue pulls that are due, renew
 * calendar push channels, then work through the outbox.
 */
import type { Ctx } from "@/server/context"
import { all, run } from "@/server/db"
import { googleConfigured } from "@/server/google/config"
import { renewChannels } from "@/server/google/containers"
import { drainJobs, enqueue } from "@/server/google/queue"

/** Minutes between polls of a workspace list/calendar. */
const ACTIVE_MINUTES = 5 // opened Taskly in the last day
const IDLE_MINUTES = 30
/** Calendars with a live push channel only need an occasional safety pull. */
const WATCHED_MINUTES = 6 * 60
const KEEP_FAILED_DAYS = 14

export async function runGoogleSync(ctx: Ctx, at: Date): Promise<number> {
  if (!(await googleConfigured(ctx))) return 0
  const now = at.toISOString()
  const dayAgo = new Date(at.getTime() - 86_400_000).toISOString()
  const containers = await all<{
    user_id: string
    kind: "tasklist" | "calendar"
    google_id: string
    polled_at: string | null
    channel_expires_at: string | null
    last_seen_at: string | null
  }>(
    ctx.db,
    `SELECT c.user_id, c.kind, c.google_id, c.polled_at, c.channel_expires_at, gc.last_seen_at
     FROM google_containers c
     JOIN google_connections gc ON gc.user_id = c.user_id AND gc.state = 'active'
     WHERE c.account_id IS NOT NULL`,
  )
  const due = containers.filter((c) => {
    const watched = c.kind === "calendar" && c.channel_expires_at !== null && c.channel_expires_at > now
    const minutes = watched
      ? WATCHED_MINUTES
      : c.last_seen_at && c.last_seen_at >= dayAgo
        ? ACTIVE_MINUTES
        : IDLE_MINUTES
    // A minute of slack so a 5-minute poll isn't skipped by a few seconds.
    const cutoff = new Date(at.getTime() - (minutes - 1) * 60_000).toISOString()
    return !c.polled_at || c.polled_at <= cutoff
  })
  await enqueue(
    ctx,
    due.map((c) => ({ kind: "pull" as const, userId: c.user_id, entityId: `${c.kind}:${c.google_id}` })),
    { drain: false },
  )
  await renewChannels(ctx, at)
  const ran = await drainJobs(ctx, { limit: 200, budgetMs: 25_000 })
  await run(
    ctx.db,
    "DELETE FROM google_sync_jobs WHERE failed_at IS NOT NULL AND failed_at < ?",
    new Date(at.getTime() - KEEP_FAILED_DAYS * 86_400_000).toISOString(),
  )
  return ran
}
