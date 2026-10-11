/**
 * Workspace tasks ↔ Google Tasks. Each connected assignee has a copy in their
 * "Taskly · <Workspace>" list. One function reconciles a copy in both
 * directions (three-way merge against the last agreed fields), whether the
 * change started in Taskly (sync job) or in Google (pull).
 */
import type { Task, TaskInput } from "@/lib/types"
import { actorFor, type Ctx } from "@/server/context"
import { first } from "@/server/db"
import { tasksApi } from "@/server/google/apis"
import { googleFor, isGone, type Google } from "@/server/google/client"
import { containerGone } from "@/server/google/containers"
import {
  FOOTER_MARK,
  googleTaskBody,
  googleTaskFields,
  statusFromDone,
  taskFields,
  type GoogleTask,
  type TaskFields,
} from "@/server/google/mapping"
import { diff, restrict, threeWayMerge } from "@/server/google/merge"
import { connectedMembers, noticeTo, taskFooter } from "@/server/google/people"
import { enqueue, queueGoogleSync } from "@/server/google/queue"
import {
  deleteLink,
  getLink,
  linksFor,
  saveLink,
  workspaceContainer,
  type ContainerRow,
  type LinkRow,
} from "@/server/google/store"
import { applyTaskUpdate, createTaskAs, deleteTaskAs, findTask } from "@/server/services/tasks"

/** What each role may change from Google (members: status only, as in the app). */
const ADMIN_FIELDS = [
  "title",
  "description",
  "dueDate",
  "done",
] as const satisfies (keyof TaskFields)[]
const MEMBER_FIELDS = ["done"] as const satisfies (keyof TaskFields)[]

const taskLink = (task: Task) => `/w/${task.accountId}/tasks?task=T-${task.number}`

/** Bring every Google copy of this task in line: add, update, or remove. */
export async function syncTask(ctx: Ctx, accountId: string, taskId: string): Promise<void> {
  const task = await findTask(ctx, accountId, taskId)
  const links = await linksFor(ctx.db, "task", taskId)
  const wanted =
    task && task.status !== "cancelled"
      ? await connectedMembers(ctx, accountId, task.assigneeIds)
      : []
  await eachPerson([
    ...links
      .filter((link) => !wanted.includes(link.user_id))
      .map((link) => () => removeTaskCopy(ctx, link)),
    ...wanted.map((userId) => () =>
      syncTaskCopy(ctx, userId, task!, links.find((link) => link.user_id === userId) ?? null),
    ),
  ])
}

/**
 * Run per-person work; one person's failure doesn't stop the others. Someone
 * who disconnected or lost access is skipped; any other failure is rethrown
 * at the end so the job retries (redoing finished steps is a no-op).
 */
export async function eachPerson(work: (() => Promise<void>)[]): Promise<void> {
  let failure: unknown = null
  for (const step of work) {
    try {
      await step()
    } catch (error) {
      if (!isConnectionError(error)) failure ??= error
    }
  }
  if (failure) throw failure
}

async function removeTaskCopy(ctx: Ctx, link: LinkRow): Promise<void> {
  try {
    const g = await googleFor(ctx, link.user_id)
    await tasksApi.delete(g, link.container_id, link.google_id)
  } catch (error) {
    if (!isGone(error) && !isConnectionError(error)) throw error
  }
  await deleteLink(ctx.db, link)
}

export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === "googleNotConnected" || code === "googleReconnect"
}

/**
 * Reconcile one person's copy. `remote`: the copy as just listed by a pull
 * (null = deleted in Google); leave it out to fetch it.
 */
export async function syncTaskCopy(
  ctx: Ctx,
  userId: string,
  task: Task,
  link: LinkRow | null,
  remote?: GoogleTask | null,
): Promise<void> {
  const g = await googleFor(ctx, userId)
  const container = await workspaceContainer(ctx.db, userId, "tasklist", task.accountId)
  if (!container) {
    await enqueue(ctx, [{ kind: "setup_member", userId, accountId: task.accountId }], { drain: false })
    return
  }
  if (!link || link.container_id !== container.google_id) {
    await insertCopy(ctx, g, container, userId, task)
    return
  }

  if (remote === undefined) {
    remote = await tasksApi.get(g, link.container_id, link.google_id).catch((error) => {
      if (isGone(error)) return null
      throw error
    })
  }
  if (!remote || remote.deleted) {
    await copyDeleted(ctx, userId, task, link, container)
    return
  }

  const base = JSON.parse(link.base) as TaskFields
  const actor = await actorFor(ctx, userId, task.accountId)
  const actual = googleTaskFields(remote)
  // An emptied title in Google reads as "unchanged"; Taskly titles can't be empty.
  const theirs = { ...actual, title: actual.title || base.title }
  const { remote: permitted, blocked } = restrict(
    base,
    theirs,
    actor?.role === "administrator" ? ADMIN_FIELDS : actor ? MEMBER_FIELDS : [],
  )
  const merged = threeWayMerge(base, taskFields(task), permitted, task.updatedAt >= (remote.updated ?? ""))

  let current = task
  if (actor && Object.keys(merged.toLocal).length > 0) {
    const value = merged.value
    const patch: Partial<TaskInput> = {}
    if ("title" in merged.toLocal) patch.title = value.title
    if ("description" in merged.toLocal) patch.description = value.description
    if ("dueDate" in merged.toLocal) {
      patch.dueDate = value.dueDate
      if (!value.dueDate) patch.dueTime = "" // no date, no time
    }
    if ("done" in merged.toLocal) patch.status = statusFromDone(value.done, task.status)
    current = await applyTaskUpdate(ctx, actor, task, patch)
    // Everyone else's copy follows (this one is patched below).
    await queueGoogleSync(ctx, "task", task.accountId, task.id, { drain: false })
  }

  const footer = await taskFooter(ctx, current, userId)
  const footerText = footer.join("\n")
  const needsPatch =
    Object.keys(diff(actual, merged.value)).length > 0 ||
    footerText !== link.footer ||
    !(remote.title ?? "").startsWith(`T-${current.number} · `)
  let etag = remote.etag ?? null
  if (needsPatch) {
    const patched = await tasksApi.patch(
      g,
      container.google_id,
      link.google_id,
      googleTaskBody(current.number, merged.value, footer),
    )
    etag = patched.etag ?? null
  }
  await saveLink(ctx.db, {
    ...link,
    etag,
    base: JSON.stringify(merged.value),
    footer: footerText,
  })
  if (blocked.length > 0) {
    await noticeTo(ctx, userId, "google_change_reverted", {
      accountId: task.accountId,
      title: current.title,
      ref: `T-${current.number}`,
      link: taskLink(current),
    })
  }
}

async function insertCopy(
  ctx: Ctx,
  g: Google,
  container: ContainerRow,
  userId: string,
  task: Task,
): Promise<void> {
  const fields = taskFields(task)
  const footer = await taskFooter(ctx, task, userId)
  let created: GoogleTask
  try {
    created = await tasksApi.insert(g, container.google_id, googleTaskBody(task.number, fields, footer))
  } catch (error) {
    if (!isGone(error)) throw error
    await containerGone(ctx, container) // they deleted the list; setup recreates it
    return
  }
  await saveLink(ctx.db, {
    kind: "task",
    entity_id: task.id,
    user_id: userId,
    account_id: task.accountId,
    container_id: container.google_id,
    google_id: created.id,
    etag: created.etag ?? null,
    base: JSON.stringify(fields),
    footer: footer.join("\n"),
  })
}

/**
 * Their copy was deleted in Google. An administrator deleting a task they
 * created deletes it in Taskly; anyone else gets the copy back, with a notice.
 */
async function copyDeleted(
  ctx: Ctx,
  userId: string,
  task: Task,
  link: LinkRow,
  container: ContainerRow,
): Promise<void> {
  await deleteLink(ctx.db, link)
  const actor = await actorFor(ctx, userId, task.accountId)
  if (actor?.role === "administrator" && task.createdById === userId) {
    await deleteTaskAs(ctx, actor, task)
    await queueGoogleSync(ctx, "task", task.accountId, task.id, { drain: false })
    return
  }
  await insertCopy(ctx, await googleFor(ctx, userId), container, userId, task)
  await noticeTo(ctx, userId, "google_item_restored", {
    accountId: task.accountId,
    title: task.title,
    ref: `T-${task.number}`,
    link: taskLink(task),
  })
}

/**
 * A task someone added to their "Taskly · <Workspace>" list in Google. An
 * administrator's becomes a workspace task assigned to them; a member's moves
 * to their own default list (members can't create workspace tasks).
 */
export async function importTask(
  ctx: Ctx,
  userId: string,
  container: ContainerRow,
  item: GoogleTask,
): Promise<void> {
  const accountId = container.account_id!
  const g = await googleFor(ctx, userId)
  if (await adoptOrphan(ctx, g, userId, container, item)) return
  const actor = await actorFor(ctx, userId, accountId)
  const fields = googleTaskFields(item)
  if (actor?.role !== "administrator") {
    await tasksApi.insert(g, "@default", {
      title: item.title ?? "",
      notes: item.notes ?? "",
      due: item.due ?? undefined,
      status: item.status ?? "needsAction",
    })
    await tasksApi.delete(g, container.google_id, item.id).catch((error) => {
      if (!isGone(error)) throw error
    })
    if (actor) await noticeTo(ctx, userId, "google_task_moved", { accountId, title: fields.title })
    return
  }
  const task = await createTaskAs(ctx, actor, {
    title: fields.title || "Untitled",
    description: fields.description,
    status: fields.done ? "completed" : "open",
    priority: "none",
    startDate: "",
    startTime: "",
    dueDate: fields.dueDate,
    dueTime: "",
    assigneeIds: [userId],
    meetingId: null,
  })
  // Adopt their Google task as this person's copy, then give it the T-n title and footer.
  const footer = await taskFooter(ctx, task, userId)
  const value = taskFields(task)
  const patched = await tasksApi.patch(g, container.google_id, item.id, googleTaskBody(task.number, value, footer))
  await saveLink(ctx.db, {
    kind: "task",
    entity_id: task.id,
    user_id: userId,
    account_id: accountId,
    container_id: container.google_id,
    google_id: item.id,
    etag: patched.etag ?? null,
    base: JSON.stringify(value),
    footer: footer.join("\n"),
  })
}

/**
 * One of Taskly's own copies without a link (two runs created it at once, or
 * a link was lost): recognised by its `T-n ·` title and footer. Adopt it if
 * this person has no copy of that task yet, otherwise delete the duplicate.
 * Returns false for anything that isn't a Taskly copy.
 */
async function adoptOrphan(
  ctx: Ctx,
  g: Google,
  userId: string,
  container: ContainerRow,
  item: GoogleTask,
): Promise<boolean> {
  const number = /^T-(\d+)\s*·/.exec(item.title ?? "")?.[1]
  if (!number || !(item.notes ?? "").includes(FOOTER_MARK)) return false
  const row = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM tasks WHERE account_id = ? AND number = ?",
    container.account_id,
    Number(number),
  )
  const task = row ? await findTask(ctx, container.account_id!, row.id) : null
  const wanted = task && task.status !== "cancelled" && task.assigneeIds.includes(userId)
  if (wanted && !(await getLink(ctx.db, "task", task.id, userId))) {
    await saveLink(ctx.db, {
      kind: "task",
      entity_id: task.id,
      user_id: userId,
      account_id: task.accountId,
      container_id: container.google_id,
      google_id: item.id,
      etag: item.etag ?? null,
      base: JSON.stringify(taskFields(task)),
      footer: "",
    })
    await syncTaskCopy(ctx, userId, task, await getLink(ctx.db, "task", task.id, userId), item)
    return true
  }
  await tasksApi.delete(g, container.google_id, item.id).catch((error) => {
    if (!isGone(error)) throw error
  })
  return true
}
