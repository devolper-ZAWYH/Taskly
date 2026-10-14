/**
 * Review cards for a task for others and for a new meeting: the details, any
 * clashes, then Create or Discard. Create uses the review's draft, exactly as
 * when the person confirms in words. When a name fits several people, the
 * card asks who they meant and reviews again.
 */
import type {
  CardView,
  DelegationReview,
  MeetingReview,
  NamedPerson,
  NeedsChoice,
} from "@/server/mcp/cards/types"
import type { CardContext, Draw, ToolResult } from "./context"
import { avatar, h, icon, type Child } from "./dom"
import { splitDue } from "./format"

type Review = DelegationReview | MeetingReview | NeedsChoice
export type ReviewKind = "delegation" | "meeting"

const TOOLS = {
  delegation: { review: "review_task_delegation", create: "delegate_task", people: "assignees" },
  meeting: { review: "review_meeting", create: "create_meeting", people: "attendees" },
} as const

type Phase =
  | { name: "review" }
  | { name: "busy" }
  | { name: "created"; link: string }
  | { name: "discarded" }
  | { name: "failed"; message: string }

/** The first line of a tool's text: its summary. */
export const summaryOf = (result: ToolResult | null) => {
  const first = result?.content?.[0]
  return first && first.type === "text" ? first.text.split("\n")[0] : ""
}

export function reviewCard(c: CardContext<Review>, kind: ReviewKind): Draw {
  const tools = TOOLS[kind]
  let phase: Phase = { name: "review" }

  async function create(review: DelegationReview | MeetingReview) {
    phase = { name: "busy" }
    c.redraw()
    const result = await c.call(tools.create, { workspace: c.view.workspaceId, draft: review.draft }).catch(() => null)
    if (!result || result.isError) {
      phase = { name: "failed", message: c.problem(result) }
      c.redraw()
      await c.tellClaude(
        `The person pressed Create on the review card, but it failed: ${summaryOf(result) || "no answer"}`,
      )
      return
    }
    const created = result.structuredContent as { task?: { link: string }; meeting?: { link: string } } | undefined
    const link = created?.task?.link ?? created?.meeting?.link ?? ""
    phase = { name: "created", link }
    c.redraw()
    await c.tellClaude(
      `The person pressed Create on the review card. ${summaryOf(result)}${link ? ` Link: ${link}` : ""} It is done: don't create it again.`,
    )
  }

  async function discard() {
    phase = { name: "discarded" }
    c.redraw()
    await c.tellClaude(
      "The person pressed Discard on the review card: nothing was created. Don't create it unless they ask again.",
    )
  }

  return () => {
    const data = c.data
    if (data.status === "needs_choice") {
      return choose(c, data, {
        kicker: `${kind === "delegation" ? c.t.newTask : c.t.newMeeting} · ${data.workspace}`,
        review: tools.review,
        rewrite: (input, chosen) => {
          const said = input[tools.people]
          return Array.isArray(said) ? { ...input, [tools.people]: said.map((q) => chosen.get(q) ?? q) } : null
        },
      })
    }
    const kicker = `${kind === "delegation" ? c.t.newTask : c.t.newMeeting} · ${data.workspace}`
    const body = data.status === "ready" && "assignees" in data ? delegation(c, data) : meeting(c, data as MeetingReview)
    return h(
      "article",
      { class: "card" },
      h("header", { class: "head" }, h("p", { class: "kicker", text: kicker }), h("h1", { class: "title" }, h("bdi", { text: data.title }))),
      phase.name === "created" ? created(c, phase.link, kind) : body,
      phase.name === "discarded" && h("p", { class: "status muted", role: "status", text: c.t.discarded }),
      phase.name === "failed" && note("danger", phase.message),
      (phase.name === "review" || phase.name === "busy") && [
        h(
          "div",
          { class: "actions" },
          h("button", {
            class: "button primary",
            type: "button",
            disabled: phase.name === "busy",
            text:
              phase.name === "busy"
                ? c.t.creating
                : kind === "delegation"
                  ? c.t.createTask
                  : c.t.createMeeting,
            onclick: () => create(data),
          }),
          h("button", {
            class: "button",
            type: "button",
            disabled: phase.name === "busy",
            text: c.t.discard,
            onclick: discard,
          }),
        ),
        h("p", { class: "hint", text: c.t.changeHint }),
      ],
    )
  }
}

function delegation(c: CardContext<Review>, data: DelegationReview): Node {
  const due = splitDue(data.due)
  return h(
    "div",
    null,
    h(
      "dl",
      { class: "facts" },
      fact(c.t.for, people(data.assignees, c.view)),
      due &&
        fact(c.t.due, [
          c.f.longDate(due.date),
          due.time && [", ", c.f.time(due.time)],
        ]),
      data.priority !== "none" && fact(c.t.priority, c.t.priorities[data.priority]),
      data.meeting && fact(c.t.fromMeeting, h("bdi", { text: data.meeting.title })),
    ),
    notes([...heard(c, data.assignees), ...(data.pastDue ? [c.t.pastDue] : [])]),
  )
}

function meeting(c: CardContext<Review>, data: MeetingReview): Node {
  const clashing = new Set(data.clashes.map((x) => x.personId))
  return h(
    "div",
    null,
    h(
      "dl",
      { class: "facts" },
      fact(c.t.when, [c.f.longDate(data.date), " · ", c.f.timeRange(data.start, data.end)]),
      data.location && fact(c.t.where, h("bdi", { text: data.location })),
      data.attendees.length > 0 && fact(c.t.who, people(data.attendees, c.view, clashing)),
      data.agenda && fact(c.t.agenda, h("span", { class: "clamp", dir: "auto", text: data.agenda })),
    ),
    data.clashes.length > 0 &&
      h(
        "section",
        { class: "note warn", "aria-label": c.t.clashes },
        icon("alert"),
        h(
          "div",
          null,
          h("p", { class: "note-title", text: c.t.clashes }),
          h(
            "ul",
            { class: "plain" },
            data.clashes.map((x) =>
              h("li", null, c.t.clash(x.person, x.meeting, c.f.time(x.time), x.person === "You")),
            ),
          ),
        ),
      ),
    notes([...heard(c, data.attendees), ...(data.past ? [c.t.pastMeeting] : [])]),
    data.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone &&
      h("p", { class: "hint", text: c.t.inZone(data.timeZone) }),
  )
}

function created(c: CardContext<Review>, link: string, kind: ReviewKind): Node {
  return h(
    "div",
    null,
    h(
      "p",
      { class: "status success", role: "status" },
      icon("check"),
      kind === "delegation" ? c.t.taskCreated : c.t.meetingCreated,
    ),
    link &&
      h(
        "div",
        { class: "actions" },
        h("button", { class: "button", type: "button", onclick: () => c.open(link) }, c.t.openInTaskly, icon("external")),
      ),
  )
}

export type ChooseOptions = {
  kicker: string
  /** The review tool to run again with the person's choices. */
  review: string
  /** The review's arguments with each unclear name swapped for the chosen id; null if it can't be. */
  rewrite: (input: Record<string, unknown>, chosen: Map<string, string>) => Record<string, unknown> | null
}

/** "Who did you mean?" for names that fit several people; then the review runs again. */
export function choose<T>(c: CardContext<T | NeedsChoice>, data: NeedsChoice, options: ChooseOptions): Node {
  const chosen = new Map<string, string>()
  const canRetry = options.rewrite(c.input, chosen) !== null && data.missing.length === 0
  const status = h("p", { class: "status muted", role: "status" })
  const next = h("button", { class: "button primary", type: "button", disabled: true, text: c.t.continue })

  next.addEventListener("click", async () => {
    next.setAttribute("disabled", "")
    next.textContent = c.t.checking
    status.textContent = ""
    const args = options.rewrite(c.input, chosen) ?? c.input
    const result = await c.call(options.review, { ...args, workspace: c.view.workspaceId }).catch(() => null)
    if (!result || result.isError || !result.structuredContent) {
      status.textContent = c.problem(result)
      next.removeAttribute("disabled")
      next.textContent = c.t.continue
      return
    }
    const review = result.structuredContent as (T | NeedsChoice) & { view?: CardView; status: string; draft?: string }
    if (review.view) c.view = review.view
    c.data = review
    c.redraw()
    const picked = data.choices
      .map((choice) => {
        const person = choice.candidates.find((p) => p.id === chosen.get(choice.query))
        return person ? `"${choice.query}" is ${person.name} (${person.id})` : ""
      })
      .filter(Boolean)
      .join("; ")
    await c.tellClaude(
      review.status === "ready"
        ? `On the card the person said who they meant: ${picked}. New review: ${summaryOf(result)} Draft: ${review.draft}. They can create it from the card, or confirm to you.`
        : `On the card the person said who they meant: ${picked}. ${summaryOf(result)}`,
    )
  })

  return h(
    "article",
    { class: "card" },
    h(
      "header",
      { class: "head" },
      h("p", { class: "kicker", text: options.kicker }),
      h("h1", { class: "title", text: c.t.whoDidYouMean }),
    ),
    data.choices.map((choice, i) =>
      h(
        "fieldset",
        { class: "choice" },
        h("legend", { text: c.t.couldBe(choice.query) }),
        choice.candidates.map((person) =>
          h(
            "label",
            { class: "row" },
            h("input", {
              type: "radio",
              name: `choice-${i}`,
              value: person.id,
              onchange: () => {
                chosen.set(choice.query, person.id)
                if (canRetry && chosen.size === data.choices.length) next.removeAttribute("disabled")
              },
            }),
            avatar(person, c.view.photos),
            h("span", { class: "row-main" }, h("span", { class: "row-title", text: person.name }), h("span", { class: "row-meta", text: person.email })),
          ),
        ),
      ),
    ),
    data.missing.map((query) => note("warn", c.t.nobodyMatches(query))),
    status,
    canRetry && h("div", { class: "actions" }, next),
  )
}

export function fact(label: string, ...value: Child[]): Node {
  return h("div", { class: "fact" }, h("dt", { text: label }), h("dd", null, ...value))
}

export function people(list: NamedPerson[], view: CardView, flagged = new Set<string>()): Node {
  return h(
    "ul",
    { class: "chips" },
    list.map((person) =>
      h(
        "li",
        { class: flagged.has(person.id) ? "chip warn" : "chip" },
        avatar(person, view.photos),
        h("span", { text: person.name }),
        flagged.has(person.id) && icon("alert"),
      ),
    ),
  )
}

const heard = (c: CardContext<Review>, list: NamedPerson[]) =>
  list.filter((p) => p.understoodFrom).map((p) => c.t.heardAs(p.understoodFrom!, p.name))

export function notes(lines: string[]): Child {
  return lines.length > 0 && h("div", { class: "notes" }, lines.map((line) => note("warn", line)))
}

export function note(tone: "warn" | "danger", text: string): Node {
  return h("p", { class: `note ${tone}`, role: tone === "danger" ? "alert" : null }, icon("alert"), h("span", { text }))
}
