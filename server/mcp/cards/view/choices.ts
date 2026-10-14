/**
 * After "Who did you mean?" on the meeting outcome card: the review's
 * arguments again, with each unclear name replaced by the person chosen,
 * wherever names appear (task assignees, next meeting attendees, minutes
 * readers). No imports, so `node --test` runs it directly.
 */
export function withChoices(input: Record<string, unknown>, chosen: Map<string, string>): Record<string, unknown> {
  const swap = (list: unknown) =>
    Array.isArray(list) ? list.map((q) => (typeof q === "string" ? (chosen.get(q) ?? q) : q)) : list
  const tasks = Array.isArray(input.tasks)
    ? input.tasks.map((t: Record<string, unknown>) => ({ ...t, assignees: swap(t.assignees) }))
    : input.tasks
  const next = input.next_meeting as Record<string, unknown> | undefined
  const minutes = input.minutes as Record<string, unknown> | undefined
  return {
    ...input,
    tasks,
    next_meeting: next ? { ...next, attendees: swap(next.attendees) } : undefined,
    minutes: minutes ? { ...minutes, share_with: swap(minutes.share_with) } : undefined,
  }
}
