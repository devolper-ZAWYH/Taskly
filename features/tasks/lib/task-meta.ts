import { isClosed } from "@/lib/api/tasks"
import type { Task, TaskPriority, TaskStatus } from "@/lib/types"

export const STATUSES: TaskStatus[] = ["open", "in_progress", "on_hold", "completed", "cancelled"]

export const PRIORITIES: TaskPriority[] = ["none", "low", "medium", "high", "urgent"]

export function formatTaskRef(number: number): string {
  return `T-${number}`
}

function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function isOverdue(task: Pick<Task, "dueDate" | "status">): boolean {
  return Boolean(task.dueDate) && !isClosed(task.status) && task.dueDate < todayYmd()
}
