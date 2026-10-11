import { rpc } from "@/lib/api/rpc"
import type {
  GoogleContainer,
  GoogleContainerKind,
  GoogleStatus,
  GoogleSyncHealth,
  PersonalEvent,
  PersonalEventInput,
  PersonalTask,
  PersonalTaskInput,
} from "@/lib/types"

/**
 * Full-page navigation (not fetch) that starts Google's consent screen. Google
 * returns to `/settings?google=connected`, or `?google=error&reason=<reason>`
 * where reason is "denied", "scopes", "unconfigured" or "failed".
 */
export const GOOGLE_CONNECT_URL = "/api/google/connect"

export const getGoogleStatus = (): Promise<GoogleStatus> => rpc("getGoogleStatus")

/**
 * Pull changes from Google now (also run when the app opens). `retryFailed`
 * ("Sync now"): also retry work that had stopped retrying.
 */
export const syncGoogleNow = (retryFailed = false): Promise<GoogleStatus> =>
  rpc("syncGoogleNow", retryFailed)

/** Removes the "Taskly · …" lists and calendars from Google and forgets the account. */
export const disconnectGoogle = (): Promise<void> => rpc("disconnectGoogle")

/** `refresh`: ask Google for the current lists/calendars first. */
export const listGoogleContainers = (refresh: boolean): Promise<GoogleContainer[]> =>
  rpc("listGoogleContainers", refresh)

export const setGoogleContainerSelected = (
  kind: GoogleContainerKind,
  id: string,
  selected: boolean,
): Promise<GoogleContainer[]> => rpc("setGoogleContainerSelected", kind, id, selected)

/** Tasks from the person's selected Google task lists. */
export const listPersonalTasks = (params: { showCompleted: boolean }): Promise<PersonalTask[]> =>
  rpc("listPersonalTasks", params)

/** `tasklistId` null = the person's default list. */
export const createPersonalTask = (
  tasklistId: string | null,
  input: PersonalTaskInput,
): Promise<PersonalTask> => rpc("createPersonalTask", tasklistId, input)

export const updatePersonalTask = (
  tasklistId: string,
  id: string,
  patch: Partial<PersonalTaskInput>,
): Promise<PersonalTask> => rpc("updatePersonalTask", tasklistId, id, patch)

export const deletePersonalTask = (tasklistId: string, id: string): Promise<void> =>
  rpc("deletePersonalTask", tasklistId, id)

/** Events on the person's selected calendars that overlap `[from, to]` (YYYY-MM-DD, in `timeZone`). */
export const listPersonalEvents = (params: {
  from: string
  to: string
  timeZone: string
}): Promise<PersonalEvent[]> => rpc("listPersonalEvents", params)

/** `calendarId` null = the person's primary calendar. */
export const createPersonalEvent = (
  calendarId: string | null,
  input: PersonalEventInput,
): Promise<PersonalEvent> => rpc("createPersonalEvent", calendarId, input)

export const updatePersonalEvent = (
  calendarId: string,
  id: string,
  input: PersonalEventInput,
): Promise<PersonalEvent> => rpc("updatePersonalEvent", calendarId, id, input)

export const deletePersonalEvent = (calendarId: string, id: string): Promise<void> =>
  rpc("deletePersonalEvent", calendarId, id)

/** Operators: failing sync work and people who must reconnect. */
export const getGoogleSyncHealth = (): Promise<GoogleSyncHealth> => rpc("getGoogleSyncHealth")

/** Operators: put every failed sync job back in the queue. */
export const retryFailedGoogleJobs = (): Promise<GoogleSyncHealth> => rpc("retryFailedGoogleJobs")
