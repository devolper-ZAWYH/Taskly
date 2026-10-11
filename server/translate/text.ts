/**
 * Pure helpers for translation: which language a text is in, and splitting
 * long text into pieces a provider accepts without losing the layout.
 * No I/O, so `node --test` can run it directly.
 */

export type Lang = "en" | "ar"

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g
const LATIN = /[A-Za-z]/g

/**
 * Arabic or English, by which script has more letters. Null when there are
 * no letters at all (numbers, times, links only): nothing to translate.
 */
export function detectLang(text: string): Lang | null {
  const arabic = text.match(ARABIC)?.length ?? 0
  const latin = text.match(LATIN)?.length ?? 0
  if (arabic === 0 && latin === 0) return null
  return arabic >= latin ? "ar" : "en"
}

export const otherLang = (lang: Lang): Lang => (lang === "ar" ? "en" : "ar")

/** Lines with something worth translating (not blank, not only digits/punctuation/links). */
export function hasWords(line: string): boolean {
  return detectLang(line.replace(/https?:\/\/\S+|\S+@\S+/g, "")) !== null
}

/** A piece of text to translate, and what follows it in the original. */
export type Chunk = { text: string; after: string }

/**
 * Split text into chunks of whole lines, each at most `max` characters; a
 * single longer line is split at sentence ends (then hard). Concatenating
 * each chunk's text and `after` gives the original back.
 */
export function chunkLines(text: string, max: number): Chunk[] {
  // Pieces of at most `max` characters, each with the separator that follows it.
  const pieces: Chunk[] = []
  const lines = text.split("\n")
  lines.forEach((line, index) => {
    const newline = index < lines.length - 1 ? "\n" : ""
    let rest = line
    while (rest.length > max) {
      const window = rest.slice(0, max)
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("، "), window.lastIndexOf("? "))
      const at = cut > max / 2 ? cut + 2 : max
      pieces.push({ text: rest.slice(0, at), after: "" })
      rest = rest.slice(at)
    }
    pieces.push({ text: rest, after: newline })
  })
  // Pack consecutive whole lines together up to `max`.
  const chunks: Chunk[] = []
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1]
    if (last && last.after === "\n" && last.text.length + 1 + piece.text.length <= max) {
      last.text += "\n" + piece.text
      last.after = piece.after
    } else {
      chunks.push({ ...piece })
    }
  }
  return chunks
}

/** SHA-256 hex of a text (which source a translation was made from). */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** What `translateText` needs from a provider (server/translate/providers.ts). */
export type TextTranslator = {
  maxChars: number
  translate(texts: string[], from: Lang, to: Lang): Promise<string[]>
}

/**
 * Translate one text, keeping its layout: long text goes in chunks of whole
 * lines, and lines with no words (numbers, times, links) stay as they are.
 */
export async function translateText(
  translator: TextTranslator,
  text: string,
  from: Lang,
  to: Lang,
): Promise<string> {
  const chunks = chunkLines(text, translator.maxChars)
  const todo = chunks.filter((chunk) => hasWords(chunk.text))
  const done = todo.length ? await translator.translate(todo.map((c) => c.text), from, to) : []
  if (done.length !== todo.length) throw new Error("The translation came back incomplete")
  return chunks
    .map((chunk) => {
      const i = todo.indexOf(chunk)
      return (i === -1 ? chunk.text : done[i].trim()) + chunk.after
    })
    .join("")
}
