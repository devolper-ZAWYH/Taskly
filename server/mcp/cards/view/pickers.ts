/**
 * Pickers: a meeting, or people. The choice goes into the chat as the
 * person's own message (so Claude carries on), with the ids passed to Claude
 * alongside, so it never has to guess which "Sara" or which "standup".
 */
import type { MeetingChoice, MeetingChoices, PeopleChoices } from "@/server/mcp/cards/types"
import type { CardContext, Draw } from "./context"
import { avatar, h, icon } from "./dom"

/** Rows shown before "Show more": enough to choose from without scrolling far. */
const FIRST_ROWS = 6

export function meetingPicker(c: CardContext<MeetingChoices>): Draw {
  const data = c.data
  let showAll = data.meetings.length <= FIRST_ROWS + 1
  let picked: MeetingChoice | null = null
  let failed = false

  async function pick(meeting: MeetingChoice) {
    picked = meeting
    c.redraw()
    await c.tellClaude(
      `On the card the person chose the meeting "${meeting.title}" on ${meeting.date} at ${meeting.start} (id ${meeting.id}).`,
    )
    const when = `${c.f.longDate(meeting.date)}, ${meeting.start}`
    failed = !(await c.say(c.t.pickedMeeting(meeting.title, when)))
    if (failed) c.redraw()
  }

  return () => {
    const rows = showAll ? data.meetings : data.meetings.slice(0, FIRST_ROWS)
    return h(
      "article",
      { class: "card" },
      h(
        "header",
        { class: "head" },
        h("p", { class: "kicker", text: data.workspace }),
        h("h1", { class: "title", text: c.t.chooseMeeting }),
      ),
      data.meetings.length === 0
        ? h("p", { class: "empty", text: c.t.noMeetingsFound })
        : h(
            "ul",
            { class: "list" },
            rows.map((m) =>
              h(
                "li",
                null,
                h(
                  "button",
                  {
                    class: picked?.id === m.id ? "row pick is-picked" : "row pick",
                    type: "button",
                    disabled: picked !== null,
                    "aria-pressed": picked?.id === m.id ? "true" : "false",
                    onclick: () => pick(m),
                  },
                  h(
                    "span",
                    { class: "row-date" },
                    m.date === data.today ? c.t.today : c.f.shortDate(m.date),
                    h("span", { class: "row-time", text: c.f.time(m.start) }),
                  ),
                  h(
                    "span",
                    { class: "row-main" },
                    h("span", { class: "row-title", text: m.title }),
                    h(
                      "span",
                      { class: "row-meta" },
                      c.t.people(m.attendees + 1),
                      m.location && [" · ", m.location],
                    ),
                  ),
                  m.hasMyMinutes && h("span", { class: "badge" }, icon("doc"), c.t.yourMinutes),
                  picked?.id === m.id && icon("check"),
                ),
              ),
            ),
          ),
      !showAll &&
        picked === null &&
        h(
          "button",
          {
            class: "more",
            type: "button",
            onclick: () => {
              showAll = true
              c.redraw()
            },
          },
          c.t.showMore(data.meetings.length - FIRST_ROWS),
        ),
      picked && !failed && h("p", { class: "status success", role: "status" }, icon("check"), c.t.sent),
      failed && h("p", { class: "status danger", role: "alert", text: c.t.errors.sendFailed }),
    )
  }
}

export function peoplePicker(c: CardContext<PeopleChoices>, purpose: string): Draw {
  const data = c.data
  const selected = new Set(data.selected)
  let query = ""
  let showAll = data.people.length <= FIRST_ROWS + 2
  let sent = false

  const title = {
    attendees: c.t.whoAttendees,
    assignees: c.t.whoAssignees,
    readers: c.t.whoReaders,
  }[purpose] ?? c.t.whoOther
  const list = h("ul", { class: "list" })
  const status = h("p", { class: "status", role: "status" })
  const done = h("button", { class: "button primary", type: "button" }) as HTMLButtonElement

  const matches = () => {
    const q = query.trim().toLowerCase()
    return q ? data.people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)) : data.people
  }

  function drawList() {
    const found = matches()
    const rows = showAll || query ? found : found.slice(0, FIRST_ROWS)
    list.replaceChildren(
      ...rows.map((person) => {
        const box = h("input", {
          type: data.multiple ? "checkbox" : "radio",
          name: "people",
          checked: selected.has(person.id),
          disabled: sent,
        }) as HTMLInputElement
        box.addEventListener("change", () => {
          if (!data.multiple) selected.clear()
          if (box.checked) selected.add(person.id)
          else selected.delete(person.id)
          drawDone()
        })
        return h(
          "li",
          null,
          h(
            "label",
            { class: "row" },
            box,
            avatar(person, c.view.photos),
            h(
              "span",
              { class: "row-main" },
              h("span", { class: "row-title", text: person.name }),
              h("span", { class: "row-meta", text: c.t.roles[person.role] }),
            ),
          ),
        )
      }),
      ...(found.length === 0 ? [h("li", { class: "empty", text: c.t.noPeopleFound })] : []),
      ...(rows.length < found.length
        ? [
            h(
              "li",
              null,
              h(
                "button",
                {
                  class: "more",
                  type: "button",
                  onclick: () => {
                    showAll = true
                    drawList()
                  },
                },
                c.t.showMore(found.length - rows.length),
              ),
            ),
          ]
        : []),
    )
  }

  function drawDone() {
    done.textContent = c.t.done(selected.size)
    done.disabled = sent || selected.size === 0
  }

  done.addEventListener("click", async () => {
    const people = data.people.filter((p) => selected.has(p.id))
    sent = true
    drawList()
    drawDone()
    await c.tellClaude(
      `On the card the person chose (${purpose}): ${people.map((p) => `${p.name} (${p.id})`).join(", ")}.`,
    )
    const ok = await c.say(c.t.pickedPeople(c.t.andList(people.map((p) => p.name))))
    status.className = ok ? "status success" : "status danger"
    status.replaceChildren(...(ok ? [icon("check"), c.t.sent] : [c.t.errors.sendFailed]))
  })

  drawList()
  drawDone()
  const card = h(
    "article",
    { class: "card" },
    h("header", { class: "head" }, h("p", { class: "kicker", text: data.workspace }), h("h1", { class: "title", text: title })),
    data.people.length > FIRST_ROWS &&
      h("input", {
        class: "search",
        type: "search",
        placeholder: c.t.searchPeople,
        "aria-label": c.t.searchPeople,
        oninput: (event: Event) => {
          query = (event.target as HTMLInputElement).value
          drawList()
        },
      }),
    list,
    status,
    h("div", { class: "actions" }, done),
  )
  return () => card
}
