import assert from "node:assert/strict"
import { test } from "node:test"
import { chunkLines, detectLang, hasWords, hashText } from "./text.ts"

test("detects Arabic and English by their letters", () => {
  assert.equal(detectLang("مراجعة الميزانية"), "ar")
  assert.equal(detectLang("Budget review"), "en")
  // Mostly Arabic with an English name inside.
  assert.equal(detectLang("اجتماع مع Acme بخصوص العقد"), "ar")
  assert.equal(detectLang("Meeting about العقد and the budget"), "en")
  assert.equal(detectLang("10:30 – 11:00 https://x.co"), "en") // the link's letters count
  assert.equal(detectLang("10:30 – 11:00"), null)
  assert.equal(detectLang(""), null)
})

test("lines with only numbers, times or links have nothing to translate", () => {
  assert.equal(hasWords("1. 10:30"), false)
  assert.equal(hasWords("https://meet.example.com/abc"), false)
  assert.equal(hasWords("- مراجعة"), true)
})

const rejoin = (chunks: { text: string; after: string }[]) =>
  chunks.map((c) => c.text + c.after).join("")

test("chunks pack whole lines and give the text back", () => {
  const text = ["- one", "", "- two", "- three three three"].join("\n")
  const chunks = chunkLines(text, 12)
  assert.ok(chunks.every((c) => c.text.length <= 12), JSON.stringify(chunks))
  assert.equal(chunks[0].text, "- one\n\n- two")
  assert.equal(rejoin(chunks), text)
})

test("a line longer than the limit is split, preferring sentence ends", () => {
  const line = "First sentence here. Second sentence here. Third one."
  const chunks = chunkLines(line, 25)
  assert.ok(chunks.every((c) => c.text.length <= 25))
  assert.equal(chunks[0].text, "First sentence here. ")
  assert.equal(rejoin(chunks), line)
})

test("hashes are stable SHA-256 hex", async () => {
  assert.equal(
    await hashText("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
})
