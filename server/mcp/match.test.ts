import assert from "node:assert/strict"
import { test } from "node:test"
import { matchPerson, normalize, skeleton, type Person } from "./match.ts"

const people: Person[] = [
  { id: "u-omar", name: "Omar Khalil", email: "omar@example.com" },
  { id: "u-sara", name: "Sara Ahmed", email: "sara@example.com" },
  { id: "u-aisha", name: "Aisha Al-Thani", email: "admin@example.com" },
  { id: "u-daniel", name: "Daniel Okafor", email: "daniel@example.com" },
  { id: "u-dana", name: "Dana Haddad", email: "dana@example.com" },
]

const found = (query: string) => {
  const m = matchPerson(query, people)
  return m.kind === "found" ? m.person.id : m.kind
}

test("exact: id, email, full name (any case)", () => {
  assert.equal(found("u-sara"), "u-sara")
  assert.equal(found("OMAR@example.com"), "u-omar")
  const m = matchPerson("aisha al-thani", people)
  assert.equal(m.kind === "found" && m.quality, "exact")
})

test("first names and prefixes", () => {
  assert.equal(found("Omar"), "u-omar")
  assert.equal(found("sara a"), "u-sara")
  const first = matchPerson("omar", people)
  assert.equal(first.kind === "found" && first.quality, "name", "a whole first name is a clear match")
  const part = matchPerson("om", people)
  assert.equal(part.kind === "found" && part.quality, "similar", "part of a name is flagged")
  const sound = matchPerson("Umar", people)
  assert.equal(sound.kind === "found" && sound.quality, "similar", "a sound-alike is flagged")
})

test("spoken and transliterated spellings", () => {
  assert.equal(found("Umar"), "u-omar")
  assert.equal(found("Sarah"), "u-sara")
  assert.equal(found("Ayesha"), "u-aisha")
  assert.equal(found("عمر"), "u-omar")
  assert.equal(found("سارة"), "u-sara")
  assert.equal(found("عائشة"), "u-aisha")
  assert.equal(found("دانيال"), "u-daniel")
})

test("never guesses between people", () => {
  const m = matchPerson("Dan", people)
  assert.equal(m.kind, "ambiguous")
  assert.deepEqual(m.kind === "ambiguous" && m.candidates.map((p) => p.id).sort(), ["u-dana", "u-daniel"])
  assert.equal(found("Zainab"), "missing")
  assert.equal(found(""), "missing")
})

test("normalising and skeletons", () => {
  assert.equal(normalize("  José  ÁLVAREZ "), "jose alvarez")
  assert.equal(normalize("أحمد"), "احمد")
  assert.equal(skeleton("Omar"), skeleton("عمر"))
  assert.equal(skeleton("Hammad"), "hmd")
})
