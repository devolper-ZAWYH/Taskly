/**
 * The person's Google task lists and calendars: the "Taskly · <Workspace>"
 * pair Taskly creates and syncs per workspace, and their own (personal) ones.
 * Also push channels for the workspace calendars, and removal on purge.
 */
import { actorFor, type Actor, type Ctx } from "@/server/context"
import { newSessionToken } from "@/server/crypto"
import { all, nowIso, run } from "@/server/db"
import { calendarApi, tasksApi } from "@/server/google/apis"
import { googleFor, isGone, type Google } from "@/server/google/client"
import { webhookUrl, tasksSyncFor } from "@/server/google/config"
import { revokeToken } from "@/server/google/oauth"
import { workspaceZone } from "@/server/google/people"
import { enqueue } from "@/server/google/queue"
import {
  containersOf,
  getConnection,
  workspaceContainer,
  type ContainerRow,
} from "@/server/google/store"
import { decryptToken } from "@/server/google/tokens"
import { encryptionKey } from "@/server/settings"

/** Keep a few days of closed tasks and past meetings in Google after connecting. */
const BACKFILL_DAYS = 30
/** Calendar push channels last a week; the cron renews them a day early. */
const CHANNEL_TTL_SECONDS = 7 * 86_400

export const containerTitle = (workspace: string) => `Taskly · ${workspace}`

// ---- Setup ---------------------------------------------------------------------

/** Right after connecting: learn their own lists/calendars, then set up each workspace. */
export async function setupUser(ctx: Ctx, userId: string): Promise<void> {
  const g = await googleFor(ctx, userId)
  await refreshPersonalContainers(ctx, g, userId)
  const memberships = await all<{ account_id: string }>(
    ctx.db,
    `SELECT ms.account_id FROM memberships ms JOIN accounts a ON a.id = ms.account_id AND a.active = 1
     WHERE ms.user_id = ?`,
    userId,
  )
  await enqueue(
    ctx,
    memberships.map((m) => ({ kind: "setup_member" as const, userId, accountId: m.account_id })),
    { drain: false },
  )
}

/**
 * Make sure this person has the workspace's task list and calendar in Google,
 * then queue a sync of every task and meeting of theirs there (backfill).
 */
export async function setupMember(ctx: Ctx, userId: string, accountId: string): Promise<void> {
  const actor = await actorFor(ctx, userId, accountId)
  if (!actor) return
  const g = await googleFor(ctx, userId)
  const tasksOn = await tasksSyncFor(ctx, userId)
  if (tasksOn) await ensureTasklist(ctx, g, actor)
  await ensureCalendar(ctx, g, actor)

  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString()
  const [tasks, meetings] = await Promise.all([
    all<{ id: string }>(
      ctx.db,
      `SELECT t.id FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = ?
       WHERE t.account_id = ? AND t.status != 'cancelled' AND (t.private = 0 OR t.google_sync = 1)
         AND (t.status != 'completed' OR t.completed_at >= ?)`,
      userId,
      accountId,
      since,
    ),
    all<{ id: string }>(
      ctx.db,
      `SELECT m.id FROM meetings m
       WHERE m.account_id = ? AND m.date >= ?
         AND (m.organizer_id = ? OR EXISTS (
           SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.user_id = ?))`,
      accountId,
      since.slice(0, 10),
      userId,
      userId,
    ),
  ])
  await enqueue(
    ctx,
    [
      ...(tasksOn ? tasks : []).map((t) => ({ kind: "sync_task" as const, accountId, entityId: t.id })),
      ...meetings.map((m) => ({ kind: "sync_meeting" as const, accountId, entityId: m.id })),
    ],
    { drain: false },
  )
}

async function ensureTasklist(ctx: Ctx, g: Google, actor: Actor): Promise<void> {
  const accountId = actor.account.id
  const existing = await workspaceContainer(ctx.db, actor.id, "tasklist", accountId)
  if (existing) {
    try {
      await tasksApi.getList(g, existing.google_id)
      return
    } catch (error) {
      if (!isGone(error)) throw error
      await forgetContainer(ctx, existing) // they deleted it in Google: start over
    }
  }
  const startedAt = nowIso()
  const list = await tasksApi.insertList(g, containerTitle(actor.account.name))
  await run(
    ctx.db,
    `INSERT INTO google_containers (user_id, kind, google_id, account_id, title, selected, polled_at)
     VALUES (?, 'tasklist', ?, ?, ?, 1, ?)`,
    actor.id,
    list.id,
    accountId,
    list.title,
    startedAt,
  )
}

async function ensureCalendar(ctx: Ctx, g: Google, actor: Actor): Promise<void> {
  const accountId = actor.account.id
  const existing = await workspaceContainer(ctx.db, actor.id, "calendar", accountId)
  if (existing) {
    // A calendar deleted in Google is noticed by its next pull (404), which sets it up again.
    try {
      if (!existing.sync_token) await saveSyncToken(ctx, g, existing)
      return
    } catch (error) {
      if (!isGone(error)) throw error
      await forgetContainer(ctx, existing)
    }
  }
  const calendar = await calendarApi.insertCalendar(g, {
    summary: containerTitle(actor.account.name),
    timeZone: await workspaceZone(ctx, accountId, actor.id),
  })
  await run(
    ctx.db,
    `INSERT INTO google_containers (user_id, kind, google_id, account_id, title, access_role, selected)
     VALUES (?, 'calendar', ?, ?, ?, 'owner', 1)`,
    actor.id,
    calendar.id,
    accountId,
    calendar.summary,
  )
  const row = (await workspaceContainer(ctx.db, actor.id, "calendar", accountId))!
  await saveSyncToken(ctx, g, row)
  await watchCalendar(ctx, g, row)
}

/** Start incremental sync from "now": list the (new or known) calendar once for its token. */
async function saveSyncToken(ctx: Ctx, g: Google, row: ContainerRow): Promise<void> {
  const { nextSyncToken } = await calendarApi.events(g, row.google_id, { showDeleted: true })
  await run(
    ctx.db,
    "UPDATE google_containers SET sync_token = ?, polled_at = ? WHERE user_id = ? AND kind = ? AND google_id = ?",
    nextSyncToken ?? null,
    nowIso(),
    row.user_id,
    row.kind,
    row.google_id,
  )
}

/** The list/calendar is gone in Google: drop it and its links; setup will recreate it. */
export async function forgetContainer(ctx: Ctx, row: ContainerRow): Promise<void> {
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM google_links WHERE user_id = ? AND container_id = ?")
      .bind(row.user_id, row.google_id),
    ctx.db
      .prepare("DELETE FROM google_containers WHERE user_id = ? AND kind = ? AND google_id = ?")
      .bind(row.user_id, row.kind, row.google_id),
  ])
}

/** A copy's list/calendar vanished mid-sync: forget it and set the workspace up again. */
export async function containerGone(ctx: Ctx, row: ContainerRow): Promise<void> {
  await forgetContainer(ctx, row)
  if (row.account_id) {
    await enqueue(ctx, [{ kind: "setup_member", userId: row.user_id, accountId: row.account_id }], {
      drain: false,
    })
  }
}

// ---- Personal lists and calendars ------------------------------------------------

/**
 * Bring the person's own task lists and calendars up to date. New ones start
 * hidden in Taskly, except their default list and primary calendar.
 */
export async function refreshPersonalContainers(ctx: Ctx, g: Google, userId: string): Promise<void> {
  const [lists, calendars, defaultList, known] = await Promise.all([
    // Their own task lists only while tasks sync is on (Taskly may not have Tasks access).
    (await tasksSyncFor(ctx, userId)) ? tasksApi.lists(g) : Promise.resolve([]),
    calendarApi.calendars(g),
    (await tasksSyncFor(ctx, userId)) ? tasksApi.getList(g, "@default").catch(() => null) : null,
    containersOf(ctx.db, userId),
  ])
  const ours = new Set(known.filter((c) => c.account_id).map((c) => `${c.kind}:${c.google_id}`))
  const found: { kind: "tasklist" | "calendar"; id: string; title: string; color: string | null; role: string | null; primary: boolean }[] = [
    ...lists.map((list) => ({
      kind: "tasklist" as const,
      id: list.id,
      title: list.title,
      color: null,
      role: "owner",
      primary: list.id === defaultList?.id,
    })),
    ...calendars
      .filter((cal) => !cal.deleted && cal.accessRole !== "freeBusyReader")
      .map((cal) => ({
        kind: "calendar" as const,
        id: cal.id,
        title: cal.summaryOverride || cal.summary || cal.id,
        color: cal.backgroundColor ?? null,
        role: cal.accessRole ?? null,
        primary: Boolean(cal.primary),
      })),
  ].filter((item) => !ours.has(`${item.kind}:${item.id}`))

  const keep = new Set(found.map((item) => `${item.kind}:${item.id}`))
  const statements = found.map((item) =>
    ctx.db
      .prepare(
        `INSERT INTO google_containers
           (user_id, kind, google_id, account_id, title, color, access_role, is_primary, selected)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, kind, google_id) DO UPDATE SET
           title = excluded.title, color = excluded.color, access_role = excluded.access_role,
           is_primary = excluded.is_primary`,
      )
      .bind(userId, item.kind, item.id, item.title, item.color, item.role, item.primary ? 1 : 0, item.primary ? 1 : 0),
  )
  for (const row of known) {
    if (!row.account_id && !keep.has(`${row.kind}:${row.google_id}`)) {
      statements.push(
        ctx.db
          .prepare("DELETE FROM google_containers WHERE user_id = ? AND kind = ? AND google_id = ?")
          .bind(userId, row.kind, row.google_id),
      )
    }
  }
  if (statements.length > 0) await ctx.db.batch(statements)
}

// ---- Push channels ----------------------------------------------------------------

/** Ask Google to call the webhook when this workspace calendar changes (needs a public URL). */
export async function watchCalendar(ctx: Ctx, g: Google, row: ContainerRow): Promise<void> {
  const address = await webhookUrl(ctx)
  if (!address) return
  const id = crypto.randomUUID()
  const token = newSessionToken()
  const channel = await calendarApi.watch(g, row.google_id, {
    id,
    address,
    token,
    ttlSeconds: CHANNEL_TTL_SECONDS,
  })
  const expires = channel.expiration
    ? new Date(Number(channel.expiration)).toISOString()
    : new Date(Date.now() + CHANNEL_TTL_SECONDS * 1000).toISOString()
  await run(
    ctx.db,
    `UPDATE google_containers SET channel_id = ?, channel_token = ?, channel_resource_id = ?,
       channel_expires_at = ? WHERE user_id = ? AND kind = ? AND google_id = ?`,
    id,
    token,
    channel.resourceId,
    expires,
    row.user_id,
    row.kind,
    row.google_id,
  )
}

async function stopChannel(g: Google, row: ContainerRow): Promise<void> {
  if (!row.channel_id || !row.channel_resource_id) return
  await calendarApi.stopChannel(g, row.channel_id, row.channel_resource_id).catch(() => undefined)
}

/** Replace channels that expire within a day (or are missing) on workspace calendars. */
export async function renewChannels(ctx: Ctx, at: Date): Promise<void> {
  if (!(await webhookUrl(ctx))) return
  const soon = new Date(at.getTime() + 86_400_000).toISOString()
  const rows = await all<ContainerRow>(
    ctx.db,
    `SELECT c.* FROM google_containers c
     JOIN google_connections gc ON gc.user_id = c.user_id AND gc.state = 'active'
     WHERE c.kind = 'calendar' AND c.account_id IS NOT NULL
       AND (c.channel_id IS NULL OR c.channel_expires_at < ?)
     LIMIT 50`,
    soon,
  )
  for (const row of rows) {
    try {
      const g = await googleFor(ctx, row.user_id)
      await stopChannel(g, row)
      await watchCalendar(ctx, g, row)
    } catch (error) {
      console.error(`google channel renewal failed for ${row.user_id}`, error)
    }
  }
}

// ---- Removal ----------------------------------------------------------------------

/** They left the workspace: remove its list and calendar from their Google account. */
export async function purgeMember(ctx: Ctx, userId: string, accountId: string): Promise<void> {
  const rows = await all<ContainerRow>(
    ctx.db,
    "SELECT * FROM google_containers WHERE user_id = ? AND account_id = ?",
    userId,
    accountId,
  )
  await removeContainers(ctx, userId, rows)
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM google_links WHERE user_id = ? AND account_id = ?")
      .bind(userId, accountId),
    ctx.db
      .prepare("DELETE FROM google_containers WHERE user_id = ? AND account_id = ?")
      .bind(userId, accountId),
  ])
}

/**
 * Disconnect: remove every "Taskly · …" list and calendar from their Google
 * account, revoke Taskly's access, and forget the connection. Their own Google
 * items are never touched.
 */
export async function purgeUser(ctx: Ctx, userId: string): Promise<void> {
  const connection = await getConnection(ctx.db, userId)
  if (!connection) return
  const rows = await all<ContainerRow>(
    ctx.db,
    "SELECT * FROM google_containers WHERE user_id = ? AND account_id IS NOT NULL",
    userId,
  )
  await removeContainers(ctx, userId, rows)
  try {
    const key = encryptionKey(ctx.env)
    if (key) await revokeToken(ctx.env, await decryptToken(key, connection.refresh_token_enc))
  } catch {
    // Already unusable; nothing to revoke.
  }
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM google_links WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM google_containers WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM google_sync_jobs WHERE user_id = ?").bind(userId),
    ctx.db.prepare("DELETE FROM google_connections WHERE user_id = ?").bind(userId),
  ])
}

/** Best effort: if Google access is already gone, just forget the rows. */
async function removeContainers(ctx: Ctx, userId: string, rows: ContainerRow[]): Promise<void> {
  if (rows.length === 0) return
  let g: Google
  try {
    g = await googleFor(ctx, userId)
  } catch {
    return
  }
  for (const row of rows) {
    try {
      if (row.kind === "tasklist") {
        await tasksApi.deleteList(g, row.google_id)
      } else {
        await stopChannel(g, row)
        await calendarApi.deleteCalendar(g, row.google_id)
      }
    } catch (error) {
      if (!isGone(error)) console.error(`google: couldn't remove ${row.kind} ${row.google_id}`, error)
    }
  }
}
