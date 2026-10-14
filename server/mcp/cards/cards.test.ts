import assert from "node:assert/strict"
import { test } from "node:test"
import { withChoices } from "./view/choices.ts"
import { initials } from "./view/dom.ts"
import { formats, splitDue } from "./view/format.ts"
import { stringsFor } from "./view/strings.ts"

test("initials: first and last word, any script", () => {
  assert.equal(initials("Omar Haddad"), "OH")
  assert.equal(initials("Aisha Al-Thani"), "AA")
  assert.equal(initials("sara"), "S")
  assert.equal(initials("سارة منصور"), "سم")
  assert.equal(initials("  "), "?")
})

test("due dates split into date and time", () => {
  assert.deepEqual(splitDue("2026-10-16 17:00"), { date: "2026-10-16", time: "17:00" })
  assert.deepEqual(splitDue("2026-10-16"), { date: "2026-10-16", time: "" })
  assert.equal(splitDue(null), null)
})

test("dates read as in the app, with Western digits in Arabic", () => {
  const en = formats("en")
  assert.equal(en.longDate("2026-10-13"), "Tuesday 13 October")
  assert.equal(en.shortDate("2026-10-13"), "Tue 13 Oct")
  const ar = formats("ar")
  assert.match(ar.longDate("2026-10-13"), /13/)
  assert.doesNotMatch(ar.longDate("2026-10-13"), /[٠-٩]/)
  // Times stay left-to-right inside Arabic sentences.
  assert.equal(ar.timeRange("15:00", "16:00"), "⁦15:00–16:00⁩")
})

test("lists of names in both languages", () => {
  assert.equal(stringsFor("en").andList(["Omar", "Sara", "Daniel"]), "Omar, Sara and Daniel")
  assert.equal(stringsFor("en").andList(["Omar"]), "Omar")
  assert.equal(stringsFor("ar").andList(["عمر", "سارة"]), "عمر وسارة")
})

test("every error a tool can send has words in both languages", () => {
  const codes = ["expired", "not_admin", "workspace_required", "write_scope", "generic"] as const
  for (const locale of ["en", "ar"] as const) {
    for (const code of codes) assert.ok(stringsFor(locale).errors[code].length > 0, `${locale}.${code}`)
  }
})

test("outcome: chosen people replace unclear names everywhere they appear", () => {
  const chosen = new Map([["Sara", "u-sara"], ["عمر", "u-omar"]])
  const input = {
    workspace: "acc-acme",
    meeting: "m-1",
    minutes: { body: "…", readers: "people", share_with: ["Sara", "Daniel"] },
    tasks: [
      { title: "a", assignees: ["عمر", "Sara"] },
      { title: "b", assignees: ["Daniel"] },
    ],
    my_tasks: [{ title: "c" }],
    next_meeting: { title: "d", date: "2026-10-21", start_time: "10:00", attendees: ["Sara"] },
  }
  const out = withChoices(input, chosen) as typeof input
  assert.deepEqual(out.tasks[0].assignees, ["u-omar", "u-sara"])
  assert.deepEqual(out.tasks[1].assignees, ["Daniel"])
  assert.deepEqual(out.minutes.share_with, ["u-sara", "Daniel"])
  assert.deepEqual(out.next_meeting.attendees, ["u-sara"])
  assert.deepEqual(out.my_tasks, input.my_tasks)
  // Parts that weren't given stay absent.
  const bare = withChoices({ meeting: "m-1", tasks: [{ title: "x", assignees: ["Sara"] }] }, chosen)
  assert.equal(bare.next_meeting, undefined)
  assert.equal(bare.minutes, undefined)
})
