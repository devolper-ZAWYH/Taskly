/**
 * Watching Google sync: alert the operators when a job gives up, show them
 * what is failing (Platform → Google sync), and retry failed work.
 */
import type { GoogleConnectionProblem, GoogleSyncHealth, GoogleSyncJobProblem } from "@/lib/types"
import type { Ctx } from "@/server/context"
import { all, first, nowIso } from "@/server/db"
import { notify } from "@/server/services/notifications"

/** However many jobs fail, operators hear about it at most once in this window. */
const ALERT_EVERY_MS = 60 * 60_000

/** A job stopped retrying: tell the operators (in the app and by push, per their preferences). */
export async function alertJobFailed(ctx: Ctx, message: string): Promise<void> {
  const since = new Date(Date.now() - ALERT_EVERY_MS).toISOString()
  const recent = await first<{ hit: number }>(
    ctx.db,
    "SELECT 1 AS hit FROM notifications WHERE type = 'google_sync_failed' AND created_at >= ? LIMIT 1",
    since,
  )
  if (recent) return
  const operators = await all<{ id: string }>(
    ctx.db,
    "SELECT id FROM users WHERE is_operator = 1 AND active = 1 AND deleted_at IS NULL",
  )
  await notify(ctx, {
    recipients: operators.map((row) => row.id),
    actorId: "",
    event: "google_sync_failed",
    accountId: null,
    data: { actor: "", title: message.slice(0, 200) },
    link: "/platform/google",
  })
}

/**
 * Put failed jobs back in the queue, all of them or one person's. Returns how
 * many. The caller drains them.
 */
export async function retryFailedJobs(ctx: Ctx, userId?: string): Promise<number> {
  const result = await ctx.db
    .prepare(
      `UPDATE google_sync_jobs
       SET failed_at = NULL, attempts = 0, next_attempt_at = ?, locked_until = NULL
       WHERE failed_at IS NOT NULL ${userId ? "AND user_id = ?" : ""}`,
    )
    .bind(nowIso(), ...(userId ? [userId] : []))
    .run()
  return result.meta.changes ?? 0
}

/** How many of this person's jobs stopped retrying. */
export async function failedJobCount(ctx: Ctx, userId: string): Promise<number> {
  const row = await first<{ n: number }>(
    ctx.db,
    "SELECT COUNT(*) AS n FROM google_sync_jobs WHERE user_id = ? AND failed_at IS NOT NULL",
    userId,
  )
  return row?.n ?? 0
}

type JobProblemRow = {
  id: string
  kind: string
  workspace: string | null
  person: string | null
  item: string | null
  attempts: number
  last_error: string | null
  failed_at: string | null
  next_attempt_at: string
}

type ConnectionProblemRow = {
  user_id: string
  name: string
  google_email: string
  state: "revoked" | "error"
  last_error: string | null
  updated_at: string
}

export async function syncHealth(ctx: Ctx): Promise<Omit<GoogleSyncHealth, "configured">> {
  const [counts, jobs, people] = await Promise.all([
    first<{ connections: number; failed: number; retrying: number; queued: number }>(
      ctx.db,
      `SELECT
         (SELECT COUNT(*) FROM google_connections WHERE state = 'active') AS connections,
         (SELECT COUNT(*) FROM google_sync_jobs WHERE failed_at IS NOT NULL) AS failed,
         (SELECT COUNT(*) FROM google_sync_jobs WHERE failed_at IS NULL AND attempts > 0) AS retrying,
         (SELECT COUNT(*) FROM google_sync_jobs WHERE failed_at IS NULL AND attempts = 0) AS queued`,
    ),
    all<JobProblemRow>(
      ctx.db,
      `SELECT j.id, j.kind, j.attempts, j.last_error, j.failed_at, j.next_attempt_at,
              a.name AS workspace, u.name AS person,
              CASE j.kind
                WHEN 'sync_task' THEN (SELECT title FROM tasks WHERE id = j.entity_id)
                WHEN 'sync_meeting' THEN (SELECT title FROM meetings WHERE id = j.entity_id)
              END AS item
       FROM google_sync_jobs j
       LEFT JOIN accounts a ON a.id = j.account_id
       LEFT JOIN users u ON u.id = j.user_id
       WHERE j.attempts > 0
       ORDER BY j.failed_at IS NULL, COALESCE(j.failed_at, j.next_attempt_at) DESC
       LIMIT 50`,
    ),
    all<ConnectionProblemRow>(
      ctx.db,
      `SELECT gc.user_id, u.name, gc.google_email, gc.state, gc.last_error, gc.updated_at
       FROM google_connections gc JOIN users u ON u.id = gc.user_id
       WHERE gc.state != 'active'
       ORDER BY gc.updated_at DESC
       LIMIT 50`,
    ),
  ])
  return {
    connections: counts?.connections ?? 0,
    failed: counts?.failed ?? 0,
    retrying: counts?.retrying ?? 0,
    queued: counts?.queued ?? 0,
    jobs: jobs.map(
      (row): GoogleSyncJobProblem => ({
        id: row.id,
        kind: row.kind,
        workspace: row.workspace,
        person: row.person,
        item: row.item,
        attempts: row.attempts,
        error: row.last_error,
        failedAt: row.failed_at,
        nextAttemptAt: row.next_attempt_at,
      }),
    ),
    people: people.map(
      (row): GoogleConnectionProblem => ({
        userId: row.user_id,
        name: row.name,
        email: row.google_email,
        state: row.state,
        error: row.last_error,
        since: row.updated_at,
      }),
    ),
  }
}
