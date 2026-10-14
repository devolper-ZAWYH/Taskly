/**
 * Everything from one meeting on one card: the minutes, tasks for the team,
 * the person's own tasks and the next meeting. Every part starts ticked; the
 * person unticks what they don't want and presses Create all, which uses the
 * review's draft exactly as when they confirm in words.
 */
import type { NamedPerson, NeedsChoice, OutcomeResult, OutcomeReview } from "@/server/mcp/cards/types"
import type { CardContext, Draw } from "./context"
import { h, icon, type Child } from "./dom"
import { splitDue } from "./format"
import { withChoices } from "./choices"
import { choose, fact, note, notes, people, summaryOf } from "./review"

type Data = OutcomeReview | NeedsChoice

type Phase =
  | { name: "review" }
  | { name: "busy" }
  | { name: "done"; result: OutcomeResult }
  | { name: "discarded" }
  | { name: "failed"; message: string }

const partsOf = (data: OutcomeReview) =>
  [data.minutes?.key, ...data.tasks.map((t) => t.key), ...data.myTasks.map((t) => t.key), data.nextMeeting?.key].filter(
    (key): key is string => Boolean(key),
  )

export function outcomeCard(c: CardContext<Data>): Draw {
  let phase: Phase = { name: "review" }
  /** Parts the person unticked. */
  const off = new Set<string>()
  // Built once per phase and data, so ticking a box keeps focus where it is.
  let node: Node | null = null
  let builtFor: { data: Data; phase: Phase } | null = null
  let createButton: HTMLButtonElement | null = null

  const setPhase = (next: Phase) => {
    phase = next
    c.redraw()
  }

  function updateButton(data: OutcomeReview) {
    if (!createButton) return
    const all = partsOf(data)
    const count = all.filter((key) => !off.has(key)).length
    createButton.textContent =
      phase.name === "busy" ? c.t.creating : count === all.length ? c.t.createAll(count) : c.t.createSelected(count)
    createButton.disabled = phase.name === "busy" || count === 0
  }

  async function create(data: OutcomeReview) {
    const skip = partsOf(data).filter((key) => off.has(key))
    setPhase({ name: "busy" })
    const result = await c
      .call("create_meeting_outcome", { workspace: c.view.workspaceId, draft: data.draft, skip })
      .catch(() => null)
    if (!result || result.isError || !result.structuredContent) {
      setPhase({ name: "failed", message: c.problem(result) })
      await c.tellClaude(
        `The person pressed Create all on the meeting review card, but it failed: ${summaryOf(result) || "no answer"}`,
      )
      return
    }
    setPhase({ name: "done", result: result.structuredContent as OutcomeResult })
    const left = skip.length ? ` They left out ${skip.join(", ")}.` : ""
    await c.tellClaude(
      `The person pressed Create all on the meeting review card.${left} ${summaryOf(result)} It is done: don't create any of it again.`,
    )
  }

  async function discard() {
    setPhase({ name: "discarded" })
    await c.tellClaude(
      "The person pressed Discard on the meeting review card: nothing was created. Don't create it unless they ask again.",
    )
  }

  /** One part, with its tick box while it can still be left out. */
  function part(key: string, data: OutcomeReview, title: Child, meta: Child[], extra?: Child): Node {
    const label = h(
      "label",
      { class: off.has(key) ? "row is-off" : "row" },
      h("input", {
        type: "checkbox",
        checked: !off.has(key),
        disabled: phase.name !== "review",
        onchange: (event: Event) => {
          if ((event.target as HTMLInputElement).checked) off.delete(key)
          else off.add(key)
          label.classList.toggle("is-off", off.has(key))
          updateButton(data)
        },
      }),
      h(
        "span",
        { class: "row-main" },
        // People write in Arabic or English whatever the card's language: keep their text in its own direction.
        h("span", { class: "row-title" }, h("bdi", null, title)),
        meta.some(Boolean) && h("span", { class: "row-meta" }, join(meta)),
      ),
    )
    return h("li", null, label, extra && h("div", { class: "part-extra" }, extra))
  }

  /** "Tue 14 Oct, 17:00", plus "overdue" when the date has passed. */
  function due(value: string | null, pastDue: boolean): Child {
    const split = splitDue(value)
    if (!split) return null
    return h(
      "span",
      pastDue ? { class: "danger-text" } : null,
      c.f.shortDate(split.date),
      split.time && [", ", c.f.time(split.time)],
      pastDue && [" · ", c.t.overdue],
    )
  }

  function readers(data: OutcomeReview): string {
    const r = data.minutes!.readers
    if (r.kind === "private") return c.t.readersPrivate
    if (r.kind === "workspace") return c.t.readersWorkspace(data.workspace)
    return c.t.readersPeople(c.t.andList(r.people.map((p) => p.name)))
  }

  function review(data: OutcomeReview): Node {
    const next = data.nextMeeting
    const heard = [
      ...data.tasks.flatMap((t) => t.assignees),
      ...(data.minutes?.readers.kind === "people" ? data.minutes.readers.people : []),
      ...(next?.attendees ?? []),
    ].filter((p, i, all): p is NamedPerson & { understoodFrom: string } =>
      Boolean(p.understoodFrom) && all.findIndex((q) => q.id === p.id) === i,
    )
    const priority = (value: OutcomeReview["tasks"][number]["priority"]) =>
      value !== "none" ? c.t.priorities[value] : null

    return h(
      "div",
      { class: "parts" },
      data.minutes &&
        section(
          c.t.minutes,
          part(
            data.minutes.key,
            data,
            c.t.saveMinutes,
            [readers(data)],
            [
              h("p", { class: "clamp", dir: "auto", text: data.minutes.body }),
              data.minutes.replaces && note("warn", c.t.replacesMinutes),
            ],
          ),
        ),
      data.tasks.length > 0 &&
        section(
          c.t.teamTasks,
          data.tasks.map((t) =>
            part(t.key, data, t.title, [c.t.andList(t.assignees.map((p) => p.name)), due(t.due, t.pastDue), priority(t.priority)]),
          ),
        ),
      data.myTasks.length > 0 &&
        section(
          c.t.yourTasks,
          data.myTasks.map((t) => part(t.key, data, t.title, [due(t.due, t.pastDue), priority(t.priority)])),
        ),
      next &&
        section(
          c.t.nextMeeting,
          part(
            next.key,
            data,
            next.title,
            [c.f.shortDate(next.date), c.f.timeRange(next.start, next.end), next.location && h("bdi", { text: next.location })],
            [
              h(
                "dl",
                { class: "facts" },
                next.attendees.length > 0 &&
                  fact(c.t.who, people(next.attendees, c.view, new Set(next.clashes.map((x) => x.personId)))),
                next.agenda && fact(c.t.agenda, h("span", { class: "clamp", dir: "auto", text: next.agenda })),
              ),
              next.clashes.map((x) => note("warn", c.t.clash(x.person, x.meeting, c.f.time(x.time), x.person === "You"))),
              next.past && note("warn", c.t.pastMeeting),
              next.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone &&
                h("p", { class: "hint", text: c.t.inZone(next.timeZone) }),
            ],
          ),
        ),
      notes(heard.map((p) => c.t.heardAs(p.understoodFrom, p.name))),
    )
  }

  function done(result: OutcomeResult): Node {
    const total = result.created.length + result.failed.length
    const headline =
      total === 0
        ? c.t.nothingCreated
        : result.failed.length > 0
          ? c.t.createdSome(result.created.length, total)
          : result.skipped.length > 0
            ? c.t.createdCount(total)
            : c.t.createdAll(total)
    return h(
      "div",
      { class: "parts" },
      h(
        "p",
        { class: result.failed.length ? "status" : "status success", role: "status" },
        result.failed.length === 0 && total > 0 && icon("check"),
        headline,
      ),
      result.created.length > 0 &&
        h(
          "ul",
          { class: "list" },
          result.created.map((item) =>
            h(
              "li",
              null,
              h(
                "button",
                { class: "row", type: "button", onclick: () => c.open(item.link) },
                icon("check"),
                h(
                  "span",
                  { class: "row-main" },
                  h("span", { class: "row-title" }, item.kind === "minutes" && c.t.minutesOf, h("bdi", { text: item.title })),
                ),
                icon("external"),
              ),
            ),
          ),
        ),
      result.failed.length > 0 &&
        section(
          c.t.notCreated,
          result.failed.map((item) => h("li", null, note("danger", `${item.title}: ${item.error}`))),
        ),
    )
  }

  function build(): Node {
    const data = c.data
    if (data.status === "needs_choice") {
      return choose(c, data, { kicker: `${c.t.meetingOutcome} · ${data.workspace}`, review: "review_meeting_outcome", rewrite: withChoices })
    }
    createButton = null
    const head = h(
      "header",
      { class: "head" },
      h("p", { class: "kicker", text: `${c.t.meetingOutcome} · ${data.workspace}` }),
      h("h1", { class: "title" }, h("bdi", { text: data.meeting.title })),
      h("p", { class: "hint", text: c.f.longDate(data.meeting.date) }),
    )
    if (phase.name === "done") return h("article", { class: "card" }, head, done(phase.result))

    const actions =
      (phase.name === "review" || phase.name === "busy") &&
      (() => {
        createButton = h("button", { class: "button primary", type: "button", onclick: () => create(data) }) as HTMLButtonElement
        updateButton(data)
        return [
          h(
            "div",
            { class: "actions" },
            createButton,
            h("button", { class: "button", type: "button", disabled: phase.name === "busy", text: c.t.discard, onclick: discard }),
          ),
          h("p", { class: "hint", text: c.t.untickHint }),
        ]
      })()
    return h(
      "article",
      { class: "card" },
      head,
      review(data),
      phase.name === "discarded" && h("p", { class: "status muted", role: "status", text: c.t.discarded }),
      phase.name === "failed" && note("danger", phase.message),
      actions,
    )
  }

  return () => {
    if (!node || builtFor?.data !== c.data || builtFor.phase !== phase) {
      node = build()
      builtFor = { data: c.data, phase }
    }
    return node
  }
}

function section(title: string, ...items: Child[]): Node {
  return h("section", null, h("h2", { class: "section", text: title }), h("ul", { class: "list" }, ...items))
}

/** "a · b · c", skipping empty parts. */
function join(parts: Child[]): Child[] {
  return parts.filter(Boolean).flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))
}
