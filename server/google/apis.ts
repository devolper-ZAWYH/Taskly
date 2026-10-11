/**
 * The Google Tasks v1 and Calendar v3 calls Taskly makes, typed to the fields
 * it reads. Ids are path-encoded: calendar ids contain `@` and `#`.
 */
import type { Google } from "@/server/google/client"
import type { GoogleEvent, GoogleTask } from "@/server/google/mapping"

const enc = encodeURIComponent

/** Enough for any real list; stops a runaway loop on a misbehaving API. */
const MAX_PAGES = 50

type Page<T> = { items?: T[]; nextPageToken?: string; nextSyncToken?: string }

async function allPages<T>(
  load: (pageToken: string | undefined) => Promise<Page<T>>,
): Promise<{ items: T[]; nextSyncToken?: string }> {
  const items: T[] = []
  let pageToken: string | undefined
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await load(pageToken)
    items.push(...(page.items ?? []))
    if (!page.nextPageToken) return { items, nextSyncToken: page.nextSyncToken }
    pageToken = page.nextPageToken
  }
  return { items }
}

// ---- Tasks -------------------------------------------------------------------

export type GoogleTaskList = { id: string; title: string; updated?: string }

export const tasksApi = {
  lists: async (g: Google) =>
    (
      await allPages<GoogleTaskList>((pageToken) =>
        g.call("GET", "/tasks/v1/users/@me/lists", { query: { maxResults: 100, pageToken } }),
      )
    ).items,

  /** `@default` resolves to the person's default list ("My Tasks"). */
  getList: (g: Google, listId: string) =>
    g.call<GoogleTaskList>("GET", `/tasks/v1/users/@me/lists/${enc(listId)}`),

  insertList: (g: Google, title: string) =>
    g.call<GoogleTaskList>("POST", "/tasks/v1/users/@me/lists", { body: { title } }),

  deleteList: (g: Google, listId: string) =>
    g.call<void>("DELETE", `/tasks/v1/users/@me/lists/${enc(listId)}`),

  list: async (
    g: Google,
    listId: string,
    query: {
      updatedMin?: string
      showCompleted?: boolean
      showHidden?: boolean
      showDeleted?: boolean
    },
  ) =>
    (
      await allPages<GoogleTask>((pageToken) =>
        g.call("GET", `/tasks/v1/lists/${enc(listId)}/tasks`, {
          query: { maxResults: 100, ...query, pageToken },
        }),
      )
    ).items,

  get: (g: Google, listId: string, taskId: string) =>
    g.call<GoogleTask>("GET", `/tasks/v1/lists/${enc(listId)}/tasks/${enc(taskId)}`),

  insert: (g: Google, listId: string, body: object) =>
    g.call<GoogleTask>("POST", `/tasks/v1/lists/${enc(listId)}/tasks`, { body }),

  patch: (g: Google, listId: string, taskId: string, body: object) =>
    g.call<GoogleTask>("PATCH", `/tasks/v1/lists/${enc(listId)}/tasks/${enc(taskId)}`, { body }),

  delete: (g: Google, listId: string, taskId: string) =>
    g.call<void>("DELETE", `/tasks/v1/lists/${enc(listId)}/tasks/${enc(taskId)}`),
}

// ---- Calendar ----------------------------------------------------------------

export type GoogleCalendarEntry = {
  id: string
  summary?: string
  summaryOverride?: string
  backgroundColor?: string
  primary?: boolean
  accessRole?: "owner" | "writer" | "reader" | "freeBusyReader"
  deleted?: boolean
}

export type GoogleChannel = { id: string; resourceId: string; expiration?: string }

export const calendarApi = {
  calendars: async (g: Google) =>
    (
      await allPages<GoogleCalendarEntry>((pageToken) =>
        g.call("GET", "/calendar/v3/users/me/calendarList", { query: { maxResults: 250, pageToken } }),
      )
    ).items,

  insertCalendar: (g: Google, body: { summary: string; timeZone: string }) =>
    g.call<{ id: string; summary: string }>("POST", "/calendar/v3/calendars", { body }),

  deleteCalendar: (g: Google, calendarId: string) =>
    g.call<void>("DELETE", `/calendar/v3/calendars/${enc(calendarId)}`),

  /** All pages. With `syncToken`, only changes since then (and a 410 when it expired). */
  events: (
    g: Google,
    calendarId: string,
    query: {
      syncToken?: string
      showDeleted?: boolean
      singleEvents?: boolean
      orderBy?: "startTime"
      timeMin?: string
      timeMax?: string
    },
  ) =>
    allPages<GoogleEvent>((pageToken) =>
      g.call("GET", `/calendar/v3/calendars/${enc(calendarId)}/events`, {
        query: { maxResults: 250, ...query, pageToken },
      }),
    ),

  get: (g: Google, calendarId: string, eventId: string) =>
    g.call<GoogleEvent>("GET", `/calendar/v3/calendars/${enc(calendarId)}/events/${enc(eventId)}`),

  insert: (g: Google, calendarId: string, body: object) =>
    g.call<GoogleEvent>("POST", `/calendar/v3/calendars/${enc(calendarId)}/events`, { body }),

  patch: (g: Google, calendarId: string, eventId: string, body: object) =>
    g.call<GoogleEvent>(
      "PATCH",
      `/calendar/v3/calendars/${enc(calendarId)}/events/${enc(eventId)}`,
      { body },
    ),

  delete: (g: Google, calendarId: string, eventId: string) =>
    g.call<void>("DELETE", `/calendar/v3/calendars/${enc(calendarId)}/events/${enc(eventId)}`),

  /** Moves an event to another calendar (only default events can move). */
  move: (g: Google, calendarId: string, eventId: string, destination: string) =>
    g.call<GoogleEvent>(
      "POST",
      `/calendar/v3/calendars/${enc(calendarId)}/events/${enc(eventId)}/move`,
      { query: { destination } },
    ),

  watch: (
    g: Google,
    calendarId: string,
    channel: { id: string; address: string; token: string; ttlSeconds: number },
  ) =>
    g.call<GoogleChannel>("POST", `/calendar/v3/calendars/${enc(calendarId)}/events/watch`, {
      body: {
        id: channel.id,
        type: "web_hook",
        address: channel.address,
        token: channel.token,
        params: { ttl: String(channel.ttlSeconds) },
      },
    }),

  stopChannel: (g: Google, id: string, resourceId: string) =>
    g.call<void>("POST", "/calendar/v3/channels/stop", { body: { id, resourceId } }),
}
