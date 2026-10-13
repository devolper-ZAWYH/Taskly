/**
 * Matching the names people say or type ("Omar", "umar", "عمر", "sara@…") to
 * workspace members. Speech and typing mangle names, so matching forgives
 * case, accents, small typos and Arabic-versus-Latin spelling — but it never
 * guesses: when more than one person fits, the caller gets the choices.
 * Pure (no imports), so `node --test` runs it directly.
 */

export type Person = { id: string; name: string; email: string }

/**
 * How sure a match is. `exact`: id, email or full name. `name`: whole words of
 * the name ("Omar", "omar haddad"). `similar`: part of a word or a name that
 * sounds alike ("Om", "Umar", "عمر") — the review says who was understood.
 */
export type MatchQuality = "exact" | "name" | "similar"

export type Match =
  | { kind: "found"; person: Person; quality: MatchQuality }
  | { kind: "ambiguous"; query: string; candidates: Person[] }
  | { kind: "missing"; query: string }

/** Lowercase, no accents or Arabic diacritics, Arabic letter variants unified. */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "") // Latin accents, Arabic harakat
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// Arabic letters as Latin consonants; long vowels and hamza carry nothing.
const ARABIC: Record<string, string> = {
  ب: "b", ت: "t", ث: "th", ج: "j", ح: "h", خ: "kh", د: "d", ذ: "dh", ر: "r", ز: "z",
  س: "s", ش: "sh", ص: "s", ض: "d", ط: "t", ظ: "z", ع: "", غ: "gh", ف: "f", ق: "k",
  ك: "k", ل: "l", م: "m", ن: "n", ه: "", و: "", ي: "", ا: "", ء: "", ئ: "", ؤ: "",
  پ: "p", چ: "ch", گ: "g", ڤ: "v",
}

/**
 * A name's consonant skeleton, so spellings of the same sound meet:
 * "Omar", "Umar" and "عمر" → "mr"; "Aisha" and "عائشة" → "sh".
 */
export function skeleton(word: string): string {
  const latin = [...normalize(word)].map((ch) => ARABIC[ch] ?? ch).join("")
  return latin
    .replace(/ph/g, "f")
    .replace(/q/g, "k")
    .replace(/[aeiouyw\s]/g, "")
    // A silent final h ("Sarah" = "Sara"), but not the h of sh, th, kh, gh, ch, dh.
    .replace(/([^stkgcd])h$/, "$1")
    .replace(/(.)\1+/g, "$1")
}

function distance(a: string, b: string): number {
  if (a === b) return 0
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

const words = (text: string) => normalize(text).split(" ").filter(Boolean)

/**
 * How well `query` fits `person`: 4 exact, 3 every word is a whole name word,
 * 2 every word starts a name word, 1 sounds alike, 0 not at all.
 */
function score(query: string, person: Person): number {
  const q = normalize(query)
  if (!q) return 0
  if (person.id === query.trim() || person.email.toLowerCase() === q || normalize(person.name) === q) {
    return 4
  }
  const nameWords = words(person.name)
  const queryWords = q.split(" ")
  if (queryWords.every((w) => nameWords.includes(w))) return 3
  if (queryWords.every((w) => nameWords.some((n) => n.startsWith(w)))) return 2
  const alike = (a: string, b: string) => {
    const [x, y] = [skeleton(a), skeleton(b)]
    return x.length >= 2 && (x === y || (Math.min(x.length, y.length) >= 3 && distance(x, y) <= 1))
  }
  if (queryWords.every((w) => nameWords.some((n) => alike(w, n)))) return 1
  return 0
}

/** The member `query` names, or the choices when that isn't certain. */
export function matchPerson(query: string, people: Person[]): Match {
  let best = 0
  let candidates: Person[] = []
  for (const person of people) {
    const s = score(query, person)
    if (s > best) {
      best = s
      candidates = [person]
    } else if (s === best && s > 0) {
      candidates.push(person)
    }
  }
  if (best === 0) return { kind: "missing", query }
  if (candidates.length > 1) return { kind: "ambiguous", query, candidates }
  const quality: MatchQuality = best === 4 ? "exact" : best === 3 ? "name" : "similar"
  return { kind: "found", person: candidates[0], quality }
}
