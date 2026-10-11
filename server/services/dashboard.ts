/**
 * The dashboard: what needs your attention today, plus (for administrators)
 * how the workspace's work is spread. One call, a handful of indexed queries.
 * Members only ever count their own visible work (never cancelled tasks).
 */
import { AppError } from "@/lib/api/core"
import type { Dashboard, PersonLoad } from "@/lib/types"
import { requireWorkspace, type Ctx } from "@/server/context"
import {
  all,
  first,
  MEETING_COLUMNS,
  MEMBER_COLUMNS,
  TASK_COLUMNS,
  toMeeting,
  toMember,
  toTask,
  type MeetingRow,
  type MemberRow,
  type TaskRow,
} from "@/server/db"
import { date } from "@/server/validate"

const OPEN = `t.status NOT IN ('completed', 'cancelled')`
const MINE = `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ?)`
const DUE_ORDER = `t.due_date, CASE WHEN t.due_time = '' THEN '23:59' ELSE t.due_time END, t.created_at`

function shift(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function getDashboard(ctx: Ctx, accountId: string, today: unknown): Promise<Dashboard> {
  const actor = await requireWorkspace(ctx, accountId)
  const day = date(today, false)
  // Sanity: the browser's "today" must be within a day of the server's.
  const serverDay = new Date().toISOString().slice(0, 10)
  if (day < shift(serverDay, -1) || day > shift(serverDay, 1)) throw new AppError("badRequest")
  const weekEnd = shift(day, 7)
  const weekAgo = shift(day, -6)
  const isAdmin = actor.role === "administrator"

  const myTasks = (where: string, ...binds: unknown[]) =>
    all<TaskRow>(
      ctx.db,
      `SELECT ${TASK_COLUMNS} FROM tasks t
       WHERE t.account_id = ? AND ${OPEN} AND ${MINE} AND ${where}
       ORDER BY ${DUE_ORDER} LIMIT 20`,
      accountId,
      actor.id,
      ...binds,
    ).then((rows) => rows.map(toTask))

  const [overdue, dueToday, upcoming, meetingRows] = await Promise.all([
    myTasks("t.due_date != '' AND t.due_date < ?", day),
    myTasks("t.due_date = ?", day),
    myTasks("t.due_date > ? AND t.due_date <= ?", day, weekEnd),
    all<MeetingRow>(
      ctx.db,
      `SELECT ${MEETING_COLUMNS} FROM meetings m
       WHERE m.account_id = ? AND m.date >= ? AND m.date <= ?
         AND (? OR m.organizer_id = ? OR EXISTS (
           SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.user_id = ?))
       ORDER BY m.date, m.start_time LIMIT 20`,
      accountId,
      day,
      weekEnd,
      isAdmin ? 1 : 0,
      actor.id,
      actor.id,
    ),
  ])

  const dashboard: Dashboard = {
    today: day,
    mine: { overdue, dueToday, upcoming },
    meetings: meetingRows.map(toMeeting),
    team: null,
  }
  if (!isAdmin) return dashboard

  const [counts, people, unassignedRows] = await Promise.all([
    first<{
      overdue: number
      unassigned: number
      due_week: number
      completed_week: number
      created_week: number
    }>(
      ctx.db,
      `SELECT
         SUM(CASE WHEN ${OPEN} AND t.due_date != '' AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN ${OPEN} AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id)
             THEN 1 ELSE 0 END) AS unassigned,
         SUM(CASE WHEN ${OPEN} AND t.due_date >= ? AND t.due_date <= ? THEN 1 ELSE 0 END) AS due_week,
         SUM(CASE WHEN t.status = 'completed' AND t.completed_at >= ? THEN 1 ELSE 0 END) AS completed_week,
         SUM(CASE WHEN t.created_at >= ? THEN 1 ELSE 0 END) AS created_week
       FROM tasks t WHERE t.account_id = ? AND t.private = 0`,
      day,
      day,
      shift(day, 6),
      weekAgo,
      weekAgo,
      accountId,
    ),
    all<MemberRow & { open_count: number; overdue_count: number }>(
      ctx.db,
      `SELECT ${MEMBER_COLUMNS},
         COUNT(t.id) AS open_count,
         SUM(CASE WHEN t.due_date != '' AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue_count
       FROM memberships ms
       JOIN users u ON u.id = ms.user_id
       LEFT JOIN task_assignees ta ON ta.user_id = u.id
       LEFT JOIN tasks t ON t.id = ta.task_id AND t.account_id = ms.account_id AND ${OPEN}
         AND t.private = 0
       WHERE ms.account_id = ? AND u.active = 1
       GROUP BY u.id
       ORDER BY open_count DESC, u.name COLLATE NOCASE`,
      day,
      accountId,
    ),
    all<TaskRow>(
      ctx.db,
      `SELECT ${TASK_COLUMNS} FROM tasks t
       WHERE t.account_id = ? AND ${OPEN} AND t.private = 0
         AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id)
       ORDER BY CASE WHEN t.due_date = '' THEN 1 ELSE 0 END, ${DUE_ORDER} LIMIT 5`,
      accountId,
    ),
  ])

  dashboard.team = {
    overdue: counts?.overdue ?? 0,
    unassigned: counts?.unassigned ?? 0,
    dueThisWeek: counts?.due_week ?? 0,
    completedThisWeek: counts?.completed_week ?? 0,
    createdThisWeek: counts?.created_week ?? 0,
    people: people.map(
      (row): PersonLoad => ({
        user: toMember(row),
        open: row.open_count ?? 0,
        overdue: row.overdue_count ?? 0,
      }),
    ),
    unassignedTasks: unassignedRows.map(toTask),
  }
  return dashboard
}
