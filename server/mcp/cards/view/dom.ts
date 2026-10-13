/**
 * A few DOM helpers for the card. Everything shown is text written by people
 * in the workspace, so it only ever goes in as text, never as HTML.
 */
export type Child = Node | string | number | null | undefined | false | Child[]

type Props = {
  class?: string
  text?: string
  onclick?: (event: MouseEvent) => void
  oninput?: (event: Event) => void
  onchange?: (event: Event) => void
  [attribute: string]: unknown
}

export function h(tag: string, props: Props | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === "class") el.className = String(value)
    else if (key === "text") el.textContent = String(value)
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener)
    } else if (key === "checked" || key === "disabled" || key === "value") {
      ;(el as unknown as Record<string, unknown>)[key] = value
    } else el.setAttribute(key, value === true ? "" : String(value))
  }
  append(el, children)
  return el
}

function append(el: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) append(el, child)
    else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** Small outlined icons, drawn in the text colour. */
const ICONS: Record<string, string> = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 8v5m0 3.5v.01M10.3 3.9L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  calendar: "M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z",
  pin: "M12 21s-6-5.6-6-11a6 6 0 0112 0c0 5.4-6 11-6 11zm0-8.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  external: "M14 4h6v6m0-6L10 14M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
  doc: "M7 3h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zm7 0v5h5M9 13h6m-6 4h6",
}

export function icon(name: keyof typeof ICONS): SVGElement {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("class", "icon")
  svg.setAttribute("aria-hidden", "true")
  const path = document.createElementNS(ns, "path")
  path.setAttribute("d", ICONS[name])
  svg.appendChild(path)
  return svg
}

/** Up to two initials: "Omar Haddad" → "OH", "عمر" → "ع". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = [words[0], words.length > 1 ? words.at(-1) : undefined]
    .filter((w): w is string => Boolean(w))
    .map((w) => Array.from(w)[0] ?? "")
  return letters.join("").toUpperCase() || "?"
}

/** A round photo, or initials when there's none or it fails to load. */
export function avatar(person: { id: string; name: string }, photos: Record<string, string>): HTMLElement {
  const fallback = () => h("span", { class: "avatar", "aria-hidden": "true", text: initials(person.name) })
  const url = photos[person.id]
  if (!url) return fallback()
  const img = h("img", { class: "avatar", alt: "", referrerpolicy: "no-referrer", src: url })
  img.addEventListener("error", () => img.replaceWith(fallback()), { once: true })
  return img
}
