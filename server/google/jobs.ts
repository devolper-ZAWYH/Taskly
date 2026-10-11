/** Runs one outbox job (see `queue.ts`). */
import type { Ctx } from "@/server/context"
import { purgeMember, purgeUser, setupMember, setupUser } from "@/server/google/containers"
import { pullContainer } from "@/server/google/pull"
import type { JobRow } from "@/server/google/queue"
import { syncMeeting } from "@/server/google/sync-meetings"
import { syncTask } from "@/server/google/sync-tasks"

export async function runJob(ctx: Ctx, job: JobRow): Promise<void> {
  const need = (value: string | null): string => {
    if (!value) throw new Error(`google sync job ${job.kind} is missing a field`)
    return value
  }
  switch (job.kind) {
    case "sync_task":
      return syncTask(ctx, need(job.account_id), need(job.entity_id))
    case "sync_meeting":
      return syncMeeting(ctx, need(job.account_id), need(job.entity_id))
    case "setup_user":
      return setupUser(ctx, need(job.user_id))
    case "setup_member":
      return setupMember(ctx, need(job.user_id), need(job.account_id))
    case "purge_member":
      return purgeMember(ctx, need(job.user_id), need(job.account_id))
    case "purge_user":
      return purgeUser(ctx, need(job.user_id))
    case "pull":
      return pullContainer(ctx, need(job.user_id), need(job.entity_id))
  }
}
