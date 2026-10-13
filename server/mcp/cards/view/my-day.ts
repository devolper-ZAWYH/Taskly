/**
 * "My day": today's meetings, and tasks due today or overdue, which can be
 * ticked done (and unticked) right on the card. Built once and updated in
 * place, so ticking with the keyboard keeps focus.
 */
import type { TaskStatus } from "@/lib/types"
import type { DayTask, MyDay } from "@/server/mcp/cards/types"
import type { CardContext, Draw } from "./context"
import { h, icon } from "./dom"
import { splitDue } from "./format"

export function myDayCard(c: CardContext<MyDay>): Draw {
  const day = c.data
  /** What changed on the card, for Claude: task title → done or reopened. */
  const changes = new Map<string, boolean>()
  const status = h("p", { class: "status danger", role: "alert", hidden: true })

  async function toggle(task: DayTask, row: HTMLElement, box: HTMLInputElement) {
    const done = box.checked
    // Unticking puts it back the way it was (open, in progress or on hold).
    const next: TaskStatus = done ? "completed" : task.status === "completed" ? "open" : task.status
    box.disabled = true
    row.classList.toggle("is-done", done)
    status.hidden = true
    const result = await c
      .call("set_task_status", { workspace: c.view.workspaceId, task: task.id, status: next })
      .catch(() => null)
    box.disabled = false
    if (!result || result.isError) {
      box.checked = !done
      row.classList.toggle("is-done", !done)
      status.textContent = c.problem(result)
      status.hidden = false
      return
    }
    changes.set(task.title, done)
    const list = [...changes].map(([title, isDone]) => `"${title}" ${isDone ? "marked done" : "reopened"}`)
    await c.tellClaude(`On the My day card the person changed tasks: ${list.join("; ")}.`)
  }

  const meetings = day.meetings.length
    ? h(
        "ul",
        { class: "list" },
        day.meetings.map((m) =>
          h(
            "li",
            null,
            h(
              "button",
              { class: "row link", type: "button", onclick: () => c.open(m.link) },
              h("span", { class: "row-time", text: c.f.timeRange(m.start, m.end) }),
              h(
                "span",
                { class: "row-main" },
                h("span", { class: "row-title", text: m.title }),
                m.location && h("span", { class: "row-meta" }, icon("pin"), m.location),
              ),
            ),
          ),
        ),
      )
    : h("p", { class: "empty", text: c.t.noMeetings })

  const tasks = day.tasks.length
    ? h(
        "ul",
        { class: "list" },
        day.tasks.map((task) => {
          const due = splitDue(task.due)
          const box = h("input", {
            type: "checkbox",
            "aria-label": c.t.markDone(task.title),
            checked: task.status === "completed",
          }) as HTMLInputElement
          const row = h(
            "label",
            { class: task.status === "completed" ? "row is-done" : "row" },
            box,
            h(
              "span",
              { class: "row-main" },
              h("span", { class: "row-title", text: task.title }),
              h(
                "span",
                { class: task.overdue ? "row-meta danger" : "row-meta" },
                task.overdue
                  ? [c.t.overdue, due && ` · ${c.f.shortDate(due.date)}`]
                  : due?.time
                    ? c.f.time(due.time)
                    : c.t.today,
              ),
            ),
          )
          box.addEventListener("change", () => toggle(task, row, box))
          return h("li", null, row)
        }),
      )
    : h("p", { class: "empty", text: c.t.noTasks })

  const card = h(
    "article",
    { class: "card" },
    h(
      "header",
      { class: "head" },
      h("p", { class: "kicker", text: `${c.t.today} · ${day.workspace}` }),
      h("h1", { class: "title", text: c.f.longDate(day.today) }),
    ),
    h("section", { "aria-label": c.t.meetings }, h("h2", { class: "section", text: c.t.meetings }), meetings),
    h(
      "section",
      { "aria-label": c.t.tasks },
      h("h2", { class: "section", text: c.t.tasks }),
      tasks,
      day.moreTasks > 0 &&
        h("button", { class: "more", type: "button", onclick: () => c.open(day.tasksLink) }, c.t.moreTasks(day.moreTasks)),
    ),
    status,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "button", type: "button", onclick: () => c.open(day.tasksLink) }, c.t.openTaskly, icon("external")),
    ),
  )
  return () => card
}
