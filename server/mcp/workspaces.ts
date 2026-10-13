/**
 * Which workspace a tool call is about. People with one workspace never have
 * to say; people with several pick one per conversation and pass it on every
 * call. The server enforces that, so nothing lands in the wrong workspace.
 */
import type { Role } from "@/lib/types"
import type { Ctx } from "@/server/context"
import { all } from "@/server/db"
import { wallClock } from "@/server/google/mapping"
import { workspaceZone } from "@/server/google/people"

export type Workspace = { id: string; name: string; role: Role }

/** Workspaces the person is a member of. Operator access to other workspaces doesn't count here. */
export function myWorkspaces(ctx: Ctx, userId: string): Promise<Workspace[]> {
  return all<Workspace>(
    ctx.db,
    `SELECT a.id, a.name, ms.role FROM memberships ms
     JOIN accounts a ON a.id = ms.account_id AND a.active = 1
     WHERE ms.user_id = ?
     ORDER BY a.name COLLATE NOCASE`,
    userId,
  )
}

const describe = (list: Workspace[]) =>
  list.map((w) => `${w.name} (id ${w.id}, ${w.role})`).join("; ")

/** The workspace `arg` names (id, or name ignoring case), or a message for the model. */
export function pickWorkspace(list: Workspace[], arg: string | undefined): Workspace | string {
  if (list.length === 0) return "You aren't a member of any active Taskly workspace."
  const wanted = arg?.trim()
  if (!wanted) {
    if (list.length === 1) return list[0]
    return (
      `workspace_required: you belong to ${list.length} workspaces: ${describe(list)}. ` +
      "Ask the person which workspace to use for this conversation (unless they already said), " +
      "then pass it as `workspace` on every call."
    )
  }
  const lower = wanted.toLowerCase()
  const match =
    list.find((w) => w.id === wanted) ??
    list.find((w) => w.name.toLowerCase() === lower) ??
    oneOf(list.filter((w) => w.name.toLowerCase().includes(lower)))
  return match ?? `No workspace matches "${wanted}". Your workspaces: ${describe(list)}.`
}

const oneOf = (list: Workspace[]) => (list.length === 1 ? list[0] : undefined)

/** Today's date and the time zone a workspace's dates mean, for reading "tomorrow", "overdue"… */
export async function workspaceClock(
  ctx: Ctx,
  accountId: string,
  userId: string,
): Promise<{ today: string; timeZone: string }> {
  const timeZone = await workspaceZone(ctx, accountId, userId)
  return { today: wallClock(new Date(), timeZone).date, timeZone }
}
