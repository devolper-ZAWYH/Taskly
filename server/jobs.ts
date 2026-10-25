/**
 * The scheduled work: every 5 minutes Google sync and translation retries,
 * hourly due date reminders. On Cloudflare the Worker's Cron Triggers run it
 * (custom-worker.ts); on a Node server a cron job calls POST /api/cron.
 */
import type { Ctx } from "@/server/context"
import { runGoogleSync } from "@/server/google/cron"
import { runDueReminders } from "@/server/services/reminders"
import { drainTranslations } from "@/server/translate/service"

export type JobKind = "frequent" | "hourly"

/** A context with no session or cookies, for work nobody is signed in for. */
export function systemContext(
  env: CloudflareEnv,
  waitUntil: (promise: Promise<unknown>) => void,
): Ctx {
  return {
    db: env.DB,
    env,
    token: null,
    setSessionCookie: () => {},
    clearSessionCookie: () => {},
    waitUntil,
  }
}

/** Run one kind of scheduled work; returns a line for the log. */
export async function runJobs(ctx: Ctx, kind: JobKind, at: Date): Promise<string> {
  if (kind === "frequent") {
    const synced = await runGoogleSync(ctx, at)
    // Translations that failed earlier (or never got their after-save run).
    const translated = await drainTranslations(ctx, { limit: 50 })
    // Live review drafts expire 15 minutes after the summarizer saved them
    // (server/live/drafts.ts); lazily swept on save too, this keeps the table
    // empty when nobody comes back to review them.
    const drafts = await sweepExpiredLiveDrafts(ctx)
    return `google sync: ${synced} jobs; translations: ${translated} ran; live drafts: ${drafts} swept`
  }
  const sent = await runDueReminders(ctx, at)
  return `due date reminders: ${sent} sent`
}

/** Drop the failed drafts: expired, nobody reviewed them (Phase 3 housekeeping). */
async function sweepExpiredLiveDrafts(ctx: Ctx): Promise<number> {
  const now = new Date().toISOString()
  const result = await ctx.db
    .prepare("DELETE FROM live_drafts WHERE expires_at < ?")
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}
