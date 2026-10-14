/**
 * The Google sync outbox. Taskly writes queue a job; jobs run right after the
 * response (`ctx.waitUntil`) and again from the 5-minute cron, with backoff.
 * The same work queued twice is one row: queuing again bumps its `version`,
 * and a finished run only removes the row if nothing re-queued it meanwhile.
 */
import { AppError } from "@/lib/api/core"
import type { Ctx } from "@/server/context"
import { newId } from "@/server/crypto"
import { all, first, nowIso, run } from "@/server/db"
import { GoogleError } from "@/server/google/client"
import { googleConfigured, googleTasksEnabled } from "@/server/google/config"

export type JobKind =
  | "sync_task"
  | "sync_meeting"
  | "setup_user"
  | "setup_member"
  | "purge_member"
  | "purge_user"
  | "pull"

export type Job = {
  kind: JobKind
  userId?: string | null
  accountId?: string | null
  /** Task/meeting id, or `<kind>:<googleId>` for a pull. */
  entityId?: string | null
}

export type JobRow = {
  id: string
  dedupe_key: string
  kind: JobKind
  user_id: string | null
  account_id: string | null
  entity_id: string | null
  version: number
  attempts: number
  next_attempt_at: string
  locked_until: string | null
  last_error: string | null
  failed_at: string | null
  created_at: string
}

/** Delay before retry n (after the nth failure); after the last, the job is marked failed. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000]
/** A crashed run releases its job after this long. */
const LOCK_MS = 2 * 60_000

/**
 * Queue Google work. A no-op unless this deployment has Google credentials and
 * someone is connected. `drain: false` when the caller is already draining.
 */
export async function enqueue(
  ctx: Ctx,
  jobs: Job[],
  options: { drain?: boolean } = {},
): Promise<void> {
  if (jobs.length === 0 || !(await googleConfigured(ctx))) return
  const now = nowIso()
  const results = await ctx.db.batch(
    jobs.map((job) =>
      ctx.db
        .prepare(
          `INSERT INTO google_sync_jobs
             (id, dedupe_key, kind, user_id, account_id, entity_id, next_attempt_at, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM google_connections WHERE state = 'active')
           ON CONFLICT (dedupe_key) DO UPDATE SET
             version = version + 1, attempts = 0, next_attempt_at = excluded.next_attempt_at,
             failed_at = NULL, last_error = NULL`,
        )
        .bind(
          newId("gj"),
          [job.kind, job.userId ?? "", job.accountId ?? "", job.entityId ?? ""].join("|"),
          job.kind,
          job.userId ?? null,
          job.accountId ?? null,
          job.entityId ?? null,
          now,
          now,
        ),
    ),
  )
  const queued = results.some((result) => (result.meta.changes ?? 0) > 0)
  if (queued && options.drain !== false) ctx.waitUntil(drainJobs(ctx).catch(logDrainError))
}

/**
 * After a task or meeting changes in Taskly: bring every person's Google copy
 * in line. A task's meeting is refreshed too, since its Google copies list
 * the action items; `meetings` adds meetings it was linked to before (a task
 * moved to another meeting, or deleted).
 */
export async function queueGoogleSync(
  ctx: Ctx,
  kind: "task" | "meeting",
  accountId: string,
  entityId: string,
  options?: { drain?: boolean; meetings?: (string | null)[] },
): Promise<void> {
  if (kind === "meeting") return enqueue(ctx, [{ kind: "sync_meeting", accountId, entityId }], options)
  const jobs: Job[] = []
  // Tasks only go to Google while tasks sync is switched on.
  if (await googleTasksEnabled(ctx)) jobs.push({ kind: "sync_task", accountId, entityId })
  const row = await first<{ meeting_id: string | null }>(
    ctx.db,
    "SELECT meeting_id FROM tasks WHERE id = ?",
    entityId,
  )
  for (const meetingId of new Set([row?.meeting_id, ...(options?.meetings ?? [])])) {
    if (meetingId) jobs.push({ kind: "sync_meeting", accountId, entityId: meetingId })
  }
  return enqueue(ctx, jobs, options)
}

/** After a workspace's time zone changed: rewrite the times on every Google copy of its meetings. */
export async function queueMeetingResync(ctx: Ctx, accountId: string): Promise<void> {
  const rows = await all<{ entity_id: string }>(
    ctx.db,
    "SELECT DISTINCT entity_id FROM google_links WHERE kind = 'meeting' AND account_id = ?",
    accountId,
  )
  await enqueue(
    ctx,
    rows.map((row) => ({ kind: "sync_meeting" as const, accountId, entityId: row.entity_id })),
  )
}

/**
 * Run due jobs until `limit` jobs ran or `budgetMs` passed. `userId` limits it
 * to that person's jobs plus task/meeting syncs, which belong to no one (the
 * "Sync now" button). Returns how many ran.
 */
export async function drainJobs(
  ctx: Ctx,
  options: { userId?: string; limit?: number; budgetMs?: number } = {},
): Promise<number> {
  const { userId, limit = 25, budgetMs = 20_000 } = options
  // Loaded lazily: the job handlers import the task/meeting services, which import this file.
  const { runJob } = await import("@/server/google/jobs")
  const started = Date.now()
  let ran = 0
  while (ran < limit && Date.now() - started < budgetMs) {
    const now = nowIso()
    const job = await first<JobRow>(
      ctx.db,
      `SELECT * FROM google_sync_jobs
       WHERE failed_at IS NULL AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?)
         ${userId ? "AND (user_id = ? OR user_id IS NULL)" : ""}
       ORDER BY next_attempt_at LIMIT 1`,
      now,
      now,
      ...(userId ? [userId] : []),
    )
    if (!job) break
    const claim = await ctx.db
      .prepare(
        `UPDATE google_sync_jobs SET locked_until = ?
         WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)`,
      )
      .bind(new Date(Date.now() + LOCK_MS).toISOString(), job.id, now)
      .run()
    if (!claim.meta.changes) continue // another run took it
    ran++
    try {
      await runJob(ctx, job)
      const done = await ctx.db
        .prepare("DELETE FROM google_sync_jobs WHERE id = ? AND version = ?")
        .bind(job.id, job.version)
        .run()
      // Re-queued while running: release it so it runs again with the newer state.
      if (!done.meta.changes) {
        await run(ctx.db, "UPDATE google_sync_jobs SET locked_until = NULL WHERE id = ?", job.id)
      }
    } catch (error) {
      await failJob(ctx, job, error)
    }
  }
  return ran
}

async function failJob(ctx: Ctx, job: JobRow, error: unknown): Promise<void> {
  // The person disconnected or must reconnect: their pending work is moot.
  if (error instanceof AppError && (error.code === "googleNotConnected" || error.code === "googleReconnect")) {
    await run(ctx.db, "DELETE FROM google_sync_jobs WHERE id = ?", job.id)
    return
  }
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
  const attempts = job.attempts + 1
  const delay = BACKOFF_MS[attempts - 1]
  // Our own rule violations and Google's 4xx answers won't fix themselves.
  const retryable = error instanceof GoogleError ? error.retryable : !(error instanceof AppError)
  console.error(`google sync job ${job.kind} failed (attempt ${attempts}): ${message}`)
  if (!retryable || delay === undefined) {
    await run(
      ctx.db,
      `UPDATE google_sync_jobs SET attempts = ?, last_error = ?, failed_at = ?, locked_until = NULL
       WHERE id = ?`,
      attempts,
      message,
      nowIso(),
      job.id,
    )
    // Loaded lazily, like the job handlers: notifications sit above this file.
    const { alertJobFailed } = await import("@/server/google/health")
    await alertJobFailed(ctx, `${job.kind}: ${message}`).catch(logDrainError)
    return
  }
  await run(
    ctx.db,
    `UPDATE google_sync_jobs SET attempts = ?, last_error = ?, next_attempt_at = ?, locked_until = NULL
     WHERE id = ?`,
    attempts,
    message,
    new Date(Date.now() + delay).toISOString(),
    job.id,
  )
}

function logDrainError(error: unknown): void {
  console.error("google sync drain failed", error)
}
