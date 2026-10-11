import { AppError } from "@/lib/api/core"
import {
  canChangeTaskStatus,
  canDeleteTask,
  canEditTask,
  canViewMeeting,
  canViewTask,
  MEMBER_STATUSES,
} from "@/lib/permissions"
import type { Page, Task, TaskInput } from "@/lib/types"
import { requireWorkspace, requireWorkspaceAdmin, type Actor, type Ctx } from "@/server/context"
import { newId } from "@/server/crypto"
import { queueGoogleSync } from "@/server/google/queue"
import { notify } from "@/server/services/notifications"
import {
  all,
  first,
  MEETING_COLUMNS,
  nowIso,
  TASK_COLUMNS,
  toMeeting,
  toTask,
  type MeetingRow,
  type TaskRow,
} from "@/server/db"
import {
  date,
  int,
  isObject,
  oneOf,
  SCOPES,
  str,
  taskFilters,
  taskInput,
  taskPatch,
} from "@/server/validate"

/** Tasks without a due date sort last; a date-only task sorts at end of day. */
const DUE_KEY = `CASE WHEN t.due_date = '' THEN '9999' ELSE t.due_date || 'T' || CASE WHEN t.due_time = '' THEN '23:59' ELSE t.due_time END END`

const CLOSED_SQL = `t.status IN ('completed', 'cancelled')`
const ASSIGNED_TO = `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?)`

export async function findTask(ctx: Ctx, accountId: string, id: string): Promise<Task | null> {
  const row = await first<TaskRow>(
    ctx.db,
    `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ? AND t.account_id = ?`,
    id,
    accountId,
  )
  return row ? toTask(row) : null
}

/** Admins see every task in the workspace; members only tasks assigned to them. */
function canAccessTask(actor: Actor, task: Task): boolean {
  return task.accountId === actor.account.id && canViewTask(actor, task)
}

/** A related meeting must exist in this workspace and be visible to the actor. */
async function assertMeeting(ctx: Ctx, actor: Actor, meetingId: string): Promise<void> {
  const row = await first<MeetingRow>(
    ctx.db,
    `SELECT ${MEETING_COLUMNS} FROM meetings m WHERE m.id = ? AND m.account_id = ?`,
    meetingId,
    actor.account.id,
  )
  if (!row || !canViewMeeting(actor, toMeeting(row))) throw new AppError("meetingNotFound")
}

export async function listTasks(ctx: Ctx, accountId: string, params: unknown): Promise<Page<Task>> {
  const actor = await requireWorkspace(ctx, accountId)
  if (!isObject(params)) throw new AppError("badRequest")
  const scope = oneOf(params.scope, SCOPES)
  const search = str(params.search, 200).trim()
  const page = int(params.page, 1, 100_000)
  const pageSize = int(params.pageSize, 1, 100)
  const filters = taskFilters(params.filters)
  const isAdmin = actor.role === "administrator"
  if (scope === "all" && !isAdmin) throw new AppError("forbidden")

  const where = ["t.account_id = ?"]
  const binds: unknown[] = [accountId]
  if (scope === "assigned") {
    where.push(`NOT ${CLOSED_SQL}`, ASSIGNED_TO)
    binds.push(actor.id)
  } else if (scope === "completed") {
    if (isAdmin) {
      where.push(CLOSED_SQL)
    } else {
      // Members never see cancelled tasks.
      where.push("t.status = 'completed'", ASSIGNED_TO)
      binds.push(actor.id)
    }
  } else {
    where.push(`NOT ${CLOSED_SQL}`)
  }
  if (filters.status) {
    where.push("t.status = ?")
    binds.push(filters.status)
  }
  if (filters.priority) {
    where.push("t.priority = ?")
    binds.push(filters.priority)
  }
  if (filters.assigneeId === "none") {
    where.push("NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id)")
  } else if (filters.assigneeId) {
    where.push(ASSIGNED_TO)
    binds.push(filters.assigneeId)
  }
  if (filters.due === "none") {
    where.push("t.due_date = ''")
  } else if (filters.due && filters.today) {
    if (filters.due === "overdue") where.push("t.due_date != '' AND t.due_date < ?")
    if (filters.due === "today") where.push("t.due_date = ?")
    if (filters.due === "week") where.push("t.due_date >= ? AND t.due_date <= date(?, '+6 days')")
    binds.push(filters.today, ...(filters.due === "week" ? [filters.today] : []))
  }
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const ref = search.replace(/^t-?/i, "")
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR t.number = ?)`)
    binds.push(like, like, /^\d+$/.test(ref) ? Number(ref) : -1)
  }
  const whereSql = where.join(" AND ")
  const order = scope === "completed" ? "t.updated_at DESC" : `${DUE_KEY} ASC, t.number DESC`

  const [rows, count] = await Promise.all([
    all<TaskRow>(
      ctx.db,
      `SELECT ${TASK_COLUMNS} FROM tasks t WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...binds,
      pageSize,
      (page - 1) * pageSize,
    ),
    first<{ total: number }>(
      ctx.db,
      `SELECT COUNT(*) AS total FROM tasks t WHERE ${whereSql}`,
      ...binds,
    ),
  ])
  return { items: rows.map(toTask), total: count?.total ?? 0 }
}

/** Look up by id or display reference (`T-12` / `12`) within the workspace. */
export async function getTask(ctx: Ctx, accountId: string, ref: unknown): Promise<Task> {
  const actor = await requireWorkspace(ctx, accountId)
  const value = str(ref, 100)
  const num = value.replace(/^t-?/i, "")
  const row = await first<TaskRow>(
    ctx.db,
    `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.account_id = ? AND (t.id = ? OR t.number = ?)`,
    accountId,
    value,
    /^\d+$/.test(num) ? Number(num) : -1,
  )
  const task = row ? toTask(row) : null
  // Hide existence from people who can't see it.
  if (!task || !canAccessTask(actor, task)) throw new AppError("notFound")
  return task
}

/** New assignees/attendees must be active members of the workspace. */
export async function assertAssignees(
  ctx: Ctx,
  accountId: string,
  ids: string[],
  previous: string[] = [],
): Promise<void> {
  const added = ids.filter((id) => !previous.includes(id)) // existing ones may stay
  if (added.length === 0) return
  const valid = await all<{ id: string }>(
    ctx.db,
    `SELECT u.id FROM users u JOIN memberships ms ON ms.user_id = u.id AND ms.account_id = ?
     WHERE u.active = 1 AND u.id IN (SELECT value FROM json_each(?))`,
    accountId,
    JSON.stringify(added),
  )
  if (valid.length !== added.length) throw new AppError("inactiveAssignee")
}

function assigneeStatements(ctx: Ctx, taskId: string, ids: string[]): D1PreparedStatement[] {
  return [
    ctx.db.prepare("DELETE FROM task_assignees WHERE task_id = ?").bind(taskId),
    ctx.db
      .prepare("INSERT INTO task_assignees (task_id, user_id) SELECT ?, value FROM json_each(?)")
      .bind(taskId, JSON.stringify(ids)),
  ]
}

export async function createTask(ctx: Ctx, accountId: string, raw: unknown): Promise<Task> {
  const actor = await requireWorkspaceAdmin(ctx, accountId)
  const task = await createTaskAs(ctx, actor, taskInput(raw))
  await queueGoogleSync(ctx, "task", accountId, task.id)
  return task
}

/**
 * Create a task as `actor` (an administrator): from the app, or from their
 * Google task list. Callers queue the Google sync.
 */
export async function createTaskAs(ctx: Ctx, actor: Actor, input: TaskInput): Promise<Task> {
  const accountId = actor.account.id
  const title = input.title.trim()
  if (!title) throw new AppError("titleRequired")
  await assertAssignees(ctx, accountId, input.assigneeIds)
  if (input.meetingId) await assertMeeting(ctx, actor, input.meetingId)

  const id = newId("t")
  const now = nowIso()
  // One transaction: bump the workspace counter and take the new number.
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE accounts SET task_counter = task_counter + 1 WHERE id = ?")
      .bind(accountId),
    ctx.db
      .prepare(
        `INSERT INTO tasks (id, account_id, number, title, description, status, priority,
           start_date, start_time, due_date, due_time, created_by_id, meeting_id,
           completed_at, created_at, updated_at)
         VALUES (?, ?, (SELECT task_counter FROM accounts WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        accountId,
        accountId,
        title,
        input.description.trim(),
        input.status,
        input.priority,
        input.startDate,
        input.startTime,
        input.dueDate,
        input.dueTime,
        actor.id,
        input.meetingId ?? null,
        input.status === "completed" ? now : null,
        now,
        now,
      ),
    ...assigneeStatements(ctx, id, input.assigneeIds),
  ])
  const task = (await findTask(ctx, accountId, id))!
  await notify(ctx, {
    recipients: task.assigneeIds,
    actorId: actor.id,
    event: "task_assigned",
    accountId,
    data: taskData(actor, task),
    link: taskLink(task),
  })
  return task
}

export async function updateTask(
  ctx: Ctx,
  accountId: string,
  id: unknown,
  raw: unknown,
): Promise<Task> {
  const actor = await requireWorkspace(ctx, accountId)
  const current = await findTask(ctx, accountId, str(id, 100))
  if (!current || !canAccessTask(actor, current)) throw new AppError("notFound")
  const task = await applyTaskUpdate(ctx, actor, current, taskPatch(raw))
  await queueGoogleSync(ctx, "task", accountId, task.id)
  return task
}

/**
 * Change a task the actor can see, with the same rules as the app: members
 * may only move their own tasks through the workflow. Used for edits made in
 * the app and in Google. Callers queue the Google sync.
 */
export async function applyTaskUpdate(
  ctx: Ctx,
  actor: Actor,
  current: Task,
  patch: Partial<TaskInput>,
): Promise<Task> {
  const accountId = actor.account.id
  if (!canAccessTask(actor, current)) throw new AppError("notFound")
  if (!canEditTask(actor)) {
    const onlyStatus = Object.keys(patch).every((key) => key === "status")
    if (
      !onlyStatus ||
      !canChangeTaskStatus(actor, current) ||
      (patch.status && !MEMBER_STATUSES.includes(patch.status))
    ) {
      throw new AppError("forbidden")
    }
  }
  if (patch.title !== undefined && !patch.title.trim()) throw new AppError("titleRequired")
  if (patch.assigneeIds)
    await assertAssignees(ctx, accountId, patch.assigneeIds, current.assigneeIds)
  if (patch.meetingId && patch.meetingId !== current.meetingId) {
    await assertMeeting(ctx, actor, patch.meetingId)
  }

  const now = nowIso()
  const next: Task = {
    ...current,
    ...patch,
    title: patch.title?.trim() ?? current.title,
    meetingId: patch.meetingId === undefined ? current.meetingId : patch.meetingId,
    updatedAt: now,
  }
  if (patch.status && patch.status !== current.status) {
    next.completedAt = patch.status === "completed" ? now : null
  }
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, start_date = ?,
           start_time = ?, due_date = ?, due_time = ?, meeting_id = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        next.title,
        next.description,
        next.status,
        next.priority,
        next.startDate,
        next.startTime,
        next.dueDate,
        next.dueTime,
        next.meetingId,
        next.completedAt,
        next.updatedAt,
        current.id,
      ),
    ...(patch.assigneeIds ? assigneeStatements(ctx, current.id, patch.assigneeIds) : []),
  ])
  const task = (await findTask(ctx, accountId, current.id))!
  const added = task.assigneeIds.filter((id) => !current.assigneeIds.includes(id))
  const common = { actorId: actor.id, accountId, data: taskData(actor, task), link: taskLink(task) }
  await notify(ctx, { ...common, recipients: added, event: "task_assigned" })
  // Everyone already on the task (and whoever created it) hears about changes.
  const watchers = [...task.assigneeIds.filter((id) => !added.includes(id)), task.createdById ?? ""]
  if (task.status !== current.status) {
    await notify(ctx, {
      ...common,
      recipients: watchers,
      event: "task_status",
      // Members can't open cancelled tasks, so the notice carries no link.
      link: task.status === "cancelled" ? null : common.link,
    })
  }
  if (task.dueDate !== current.dueDate || task.dueTime !== current.dueTime) {
    await notify(ctx, {
      ...common,
      recipients: watchers,
      event: "task_due",
      data: { ...common.data, date: task.dueDate, time: task.dueTime },
    })
  }
  return task
}

function taskData(actor: Actor, task: Task) {
  return {
    actor: actor.user.name,
    workspace: actor.account.name,
    ref: `T-${task.number}`,
    title: task.title,
    status: task.status,
  }
}

function taskLink(task: Task): string {
  return `/w/${task.accountId}/tasks?task=T-${task.number}`
}

export async function cancelTask(ctx: Ctx, accountId: string, id: unknown): Promise<Task> {
  return updateTask(ctx, accountId, id, { status: "cancelled" } satisfies Partial<TaskInput>)
}

export async function deleteTask(ctx: Ctx, accountId: string, id: unknown): Promise<void> {
  const actor = await requireWorkspace(ctx, accountId)
  const task = await findTask(ctx, accountId, str(id, 100))
  if (!task || !canAccessTask(actor, task)) throw new AppError("notFound")
  await deleteTaskAs(ctx, actor, task)
  await queueGoogleSync(ctx, "task", accountId, task.id)
}

/** Delete as `actor` (administrators only). Callers queue the Google sync. */
export async function deleteTaskAs(ctx: Ctx, actor: Actor, task: Task): Promise<void> {
  if (!canDeleteTask(actor)) throw new AppError("forbidden")
  await ctx.db.prepare("DELETE FROM tasks WHERE id = ?").bind(task.id).run()
}

/** Tasks with a due date in `[from, to]` (YYYY-MM-DD), for the calendar. */
export async function listCalendarTasks(
  ctx: Ctx,
  accountId: string,
  params: unknown,
): Promise<Task[]> {
  const actor = await requireWorkspace(ctx, accountId)
  if (!isObject(params)) throw new AppError("badRequest")
  const from = date(params.from, false)
  const to = date(params.to, false)
  const isAdmin = actor.role === "administrator" ? 1 : 0
  const rows = await all<TaskRow>(
    ctx.db,
    `SELECT ${TASK_COLUMNS} FROM tasks t
     WHERE t.account_id = ? AND t.status != 'cancelled' AND t.due_date >= ? AND t.due_date <= ?
       AND (? OR ${ASSIGNED_TO})
     ORDER BY ${DUE_KEY}`,
    accountId,
    from,
    to,
    isAdmin,
    actor.id,
  )
  return rows.map(toTask)
}
