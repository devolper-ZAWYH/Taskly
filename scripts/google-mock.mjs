#!/usr/bin/env node
/**
 * In-memory stand-in for the parts of Google that Taskly's sync uses: OAuth
 * (consent is auto-approved), Tasks v1 and Calendar v3. For local testing
 * without a Google Cloud project:
 *
 *   node scripts/google-mock.mjs            # http://localhost:3199
 *
 * then in .dev.vars set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to anything,
 * and GOOGLE_API_ORIGIN / GOOGLE_OAUTH_ORIGIN to http://localhost:3199.
 * Change things "in Google" with the same REST calls (any bearer token works),
 * e.g. PATCH /tasks/v1/lists/<list>/tasks/<task>. GET /__state dumps everything;
 * POST /__reset starts over. Data lives in memory only.
 */
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"

const PORT = Number(process.env.PORT ?? 3199)
const EMAIL = process.env.MOCK_EMAIL ?? "you@example.com"

let state
let seq
function reset() {
  seq = 0
  state = {
    lists: new Map(),
    calendars: new Map(),
    channels: new Map(),
  }
  addList("list-default", "My Tasks")
  addCalendar(EMAIL, { summary: EMAIL, primary: true, accessRole: "owner", timeZone: "Asia/Qatar" })
  addCalendar("holidays@group.v.calendar.google.com", {
    summary: "Holidays",
    accessRole: "reader",
    timeZone: "UTC",
  })
}

const now = () => new Date().toISOString()
const etag = () => `"${++seq}"`

function addList(id, title) {
  const list = { id, title, updated: now(), tasks: new Map() }
  state.lists.set(id, list)
  return list
}

function addCalendar(id, props) {
  const calendar = { id, backgroundColor: "#4285f4", events: new Map(), ...props }
  state.calendars.set(id, calendar)
  return calendar
}

// ---- helpers -------------------------------------------------------------------

/** Google patch semantics: objects merge recursively, null clears, arrays replace. */
function patch(target, changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete target[key]
    else if (typeof value === "object" && !Array.isArray(value) && typeof target[key] === "object") {
      patch(target[key], value)
    } else target[key] = value
  }
  return target
}

function offsetMinutes(zone, at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at)
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return Math.round((asUtc - at.getTime()) / 60_000)
}

/** Google returns dateTime with the offset of the event's zone. */
function normalizeTime(time, fallbackZone) {
  if (!time?.dateTime) return time
  const zone = time.timeZone ?? fallbackZone ?? "UTC"
  const hasOffset = /([+-]\d\d:\d\d|Z)$/.test(time.dateTime)
  let instant = hasOffset ? new Date(time.dateTime) : null
  if (!instant) {
    const guess = new Date(`${time.dateTime}Z`)
    instant = new Date(guess.getTime() - offsetMinutes(zone, guess) * 60_000)
  }
  const offset = offsetMinutes(zone, instant)
  const local = new Date(instant.getTime() + offset * 60_000).toISOString().slice(0, 19)
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
  return { ...time, dateTime: `${local}${sign}${hhmm}`, timeZone: zone }
}

function touchTask(task) {
  task.updated = now()
  task.etag = etag()
  task.seq = seq
  if (task.status === "completed" && !task.completed) task.completed = task.updated
  if (task.status !== "completed") delete task.completed
  if (task.due) task.due = `${task.due.slice(0, 10)}T00:00:00.000Z`
  return task
}

function touchEvent(event, calendar) {
  event.updated = now()
  event.etag = etag()
  event.seq = seq
  event.start = normalizeTime(event.start, calendar.timeZone)
  event.end = normalizeTime(event.end, calendar.timeZone)
  return event
}

const omit = (object, key) => {
  const copy = { ...object }
  delete copy[key]
  return copy
}
const strip = (item) => omit(item, "seq")

// ---- routes --------------------------------------------------------------------

const routes = []
const route = (method, pattern, handler) =>
  routes.push({ method, regex: new RegExp(`^${pattern}$`), handler })

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const notFound = () => {
  throw new HttpError(404, "Not Found")
}

const list = (id) => state.lists.get(id === "@default" ? "list-default" : id) ?? notFound()
const calendar = (id) => state.calendars.get(id === "primary" ? EMAIL : id) ?? notFound()

// OAuth: consent is approved on the spot.
route("GET", "/o/oauth2/v2/auth", ({ query }) => {
  const to = new URL(query.get("redirect_uri"))
  to.searchParams.set("code", `code-${randomUUID()}`)
  to.searchParams.set("state", query.get("state"))
  state.lastScope = query.get("scope")
  return { redirect: to.toString() }
})
route("POST", "/token", ({ form }) => {
  const idToken = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "mock-sub-1", email: EMAIL })).toString("base64url"),
    "",
  ].join(".")
  return {
    access_token: `access-${randomUUID()}`,
    expires_in: 3600,
    token_type: "Bearer",
    scope: state.lastScope ?? "",
    ...(form.get("grant_type") === "authorization_code"
      ? { refresh_token: `refresh-${randomUUID()}`, id_token: idToken }
      : {}),
  }
})
route("POST", "/revoke", () => ({}))

// Tasks: lists.
route("GET", "/tasks/v1/users/@me/lists", () => ({
  items: [...state.lists.values()].map((l) => omit(l, "tasks")),
}))
route("GET", "/tasks/v1/users/@me/lists/([^/]+)", ({ params }) => omit(list(params[0]), "tasks"))
route("POST", "/tasks/v1/users/@me/lists", ({ body }) =>
  omit(addList(`list-${randomUUID().slice(0, 8)}`, body.title), "tasks"),
)
route("DELETE", "/tasks/v1/users/@me/lists/([^/]+)", ({ params }) => {
  list(params[0])
  state.lists.delete(params[0])
  return null
})

// Tasks: tasks.
route("GET", "/tasks/v1/lists/([^/]+)/tasks", ({ params, query }) => {
  const showCompleted = query.get("showCompleted") !== "false"
  const showHidden = query.get("showHidden") === "true"
  const showDeleted = query.get("showDeleted") === "true"
  const updatedMin = query.get("updatedMin")
  const items = [...list(params[0]).tasks.values()].filter(
    (t) =>
      (showDeleted || !t.deleted) &&
      (showHidden || !t.hidden) &&
      (showCompleted || t.status !== "completed") &&
      (!updatedMin || t.updated >= updatedMin),
  )
  return { items: items.map(strip) }
})
route("GET", "/tasks/v1/lists/([^/]+)/tasks/([^/]+)", ({ params }) => {
  const task = list(params[0]).tasks.get(params[1])
  if (!task || task.deleted) notFound()
  return strip(task)
})
route("POST", "/tasks/v1/lists/([^/]+)/tasks", ({ params, body }) => {
  const id = `task-${randomUUID().slice(0, 8)}`
  const task = touchTask({ status: "needsAction", ...body, id, webViewLink: `https://tasks.google.com/task/${id}` })
  list(params[0]).tasks.set(id, task)
  return strip(task)
})
route("PATCH", "/tasks/v1/lists/([^/]+)/tasks/([^/]+)", ({ params, body }) => {
  const task = list(params[0]).tasks.get(params[1])
  if (!task || task.deleted) notFound()
  return strip(touchTask(patch(task, body)))
})
route("DELETE", "/tasks/v1/lists/([^/]+)/tasks/([^/]+)", ({ params }) => {
  const task = list(params[0]).tasks.get(params[1])
  if (!task || task.deleted) notFound()
  task.deleted = true
  touchTask(task)
  return null
})

// Calendar: calendar list and calendars.
route("GET", "/calendar/v3/users/me/calendarList", () => ({
  items: [...state.calendars.values()].map((c) => omit(c, "events")),
}))
route("POST", "/calendar/v3/calendars", ({ body }) => {
  const id = `cal-${randomUUID().slice(0, 8)}@group.calendar.google.com`
  return omit(addCalendar(id, { summary: body.summary, timeZone: body.timeZone, accessRole: "owner" }), "events")
})
route("DELETE", "/calendar/v3/calendars/([^/]+)", ({ params }) => {
  calendar(params[0])
  state.calendars.delete(params[0])
  return null
})

// Calendar: events.
route("GET", "/calendar/v3/calendars/([^/]+)/events", ({ params, query }) => {
  const cal = calendar(params[0])
  const syncToken = query.get("syncToken")
  const all = [...cal.events.values()]
  if (syncToken) {
    if (syncToken === "expired") throw new HttpError(410, "Sync token is no longer valid")
    const since = Number(syncToken.slice(1))
    return { items: all.filter((e) => e.seq > since).map(strip), nextSyncToken: `s${seq}` }
  }
  const showDeleted = query.get("showDeleted") === "true"
  const timeMin = query.get("timeMin")
  const timeMax = query.get("timeMax")
  const instant = (t) => (t?.dateTime ? new Date(t.dateTime).toISOString() : `${t?.date}T00:00:00.000Z`)
  const items = all
    .filter((e) => showDeleted || e.status !== "cancelled")
    .filter((e) => !timeMin || instant(e.end) > timeMin)
    .filter((e) => !timeMax || instant(e.start) < timeMax)
    .sort((a, b) => instant(a.start).localeCompare(instant(b.start)))
  return { items: items.map(strip), nextSyncToken: `s${seq}` }
})
route("GET", "/calendar/v3/calendars/([^/]+)/events/([^/]+)", ({ params }) => {
  const event = calendar(params[0]).events.get(params[1]) ?? notFound()
  return strip(event)
})
route("POST", "/calendar/v3/calendars/([^/]+)/events", ({ params, body }) => {
  const cal = calendar(params[0])
  const id = `ev${randomUUID().replace(/-/g, "").slice(0, 12)}`
  const event = touchEvent(
    {
      status: "confirmed",
      ...body,
      id,
      organizer: { email: cal.id, self: cal.primary === true },
      htmlLink: `https://calendar.google.com/event?eid=${id}`,
    },
    cal,
  )
  cal.events.set(id, event)
  return strip(event)
})
route("PATCH", "/calendar/v3/calendars/([^/]+)/events/([^/]+)", ({ params, body }) => {
  const cal = calendar(params[0])
  const event = cal.events.get(params[1]) ?? notFound()
  return strip(touchEvent(patch(event, body), cal))
})
route("DELETE", "/calendar/v3/calendars/([^/]+)/events/([^/]+)", ({ params }) => {
  const cal = calendar(params[0])
  const event = cal.events.get(params[1])
  if (!event || event.status === "cancelled") throw new HttpError(410, "Resource has been deleted")
  event.status = "cancelled"
  touchEvent(event, cal)
  return null
})
route("POST", "/calendar/v3/calendars/([^/]+)/events/([^/]+)/move", ({ params, query }) => {
  const from = calendar(params[0])
  const to = calendar(query.get("destination"))
  const event = from.events.get(params[1]) ?? notFound()
  const moved = touchEvent({ ...structuredClone(event), organizer: { email: to.id, self: true } }, to)
  to.events.set(moved.id, moved)
  event.status = "cancelled"
  touchEvent(event, from)
  return strip(moved)
})
route("POST", "/calendar/v3/calendars/([^/]+)/events/watch", ({ params, body }) => {
  calendar(params[0])
  const channel = { id: body.id, resourceId: `res-${randomUUID().slice(0, 8)}`, expiration: String(Date.now() + 7 * 86_400_000) }
  state.channels.set(channel.id, { ...channel, calendarId: params[0], address: body.address, token: body.token })
  return channel
})
route("POST", "/calendar/v3/channels/stop", ({ body }) => {
  state.channels.delete(body.id)
  return null
})

// Test controls.
route("GET", "/__state", () => ({
  lists: [...state.lists.values()].map((l) => ({ ...l, tasks: [...l.tasks.values()].map(strip) })),
  calendars: [...state.calendars.values()].map((c) => ({ ...c, events: [...c.events.values()].map(strip) })),
  channels: [...state.channels.values()],
}))
route("POST", "/__reset", () => {
  reset()
  return {}
})

// ---- server --------------------------------------------------------------------

reset()
createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString()
  const send = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(data === null ? "" : JSON.stringify(data))
  }
  try {
    for (const r of routes) {
      const match = req.method === r.method && url.pathname.match(r.regex)
      if (!match) continue
      const isForm = (req.headers["content-type"] ?? "").includes("x-www-form-urlencoded")
      const result = r.handler({
        params: match.slice(1).map(decodeURIComponent),
        query: url.searchParams,
        body: !isForm && raw ? JSON.parse(raw) : {},
        form: new URLSearchParams(isForm ? raw : ""),
      })
      if (result?.redirect) {
        res.writeHead(302, { location: result.redirect })
        return res.end()
      }
      return result === null ? send(204, null) : send(200, result)
    }
    send(404, { error: { code: 404, message: `No mock for ${req.method} ${url.pathname}` } })
  } catch (error) {
    const status = error.status ?? 500
    send(status, { error: { code: status, message: error.message, errors: [{ reason: status === 410 ? "deleted" : "error" }] } })
  }
}).listen(PORT, () => console.log(`Google mock on http://localhost:${PORT} (account ${EMAIL})`))
