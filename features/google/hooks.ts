"use client"

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { meetingKeys } from "@/features/calendar/hooks/use-meetings"
import { taskKeys } from "@/features/tasks/hooks/use-tasks"
import { useWorkspace } from "@/features/workspace/workspace-context"
import { AppError } from "@/lib/api/core"
import {
  addGoogleEventToWorkspace,
  createPersonalEvent,
  createPersonalTask,
  deletePersonalEvent,
  deletePersonalTask,
  disconnectGoogle,
  getGoogleStatus,
  listGoogleContainers,
  listPersonalEvents,
  listPersonalTasks,
  previewGoogleEventImport,
  setGoogleContainerSelected,
  syncGoogleNow,
  updatePersonalEvent,
  updatePersonalTask,
} from "@/lib/api/google"
import type {
  GoogleContainer,
  GoogleContainerKind,
  GoogleStatus,
  MeetingInput,
  PersonalEventInput,
  PersonalTask,
  PersonalTaskInput,
} from "@/lib/types"

/** Everything Google lives under ["google", …]; it belongs to the person, not a workspace. */
export const googleKeys = {
  all: ["google"] as const,
  status: ["google", "status"] as const,
  /** Containers as stored (calendar form's picker). */
  containers: ["google", "containers"] as const,
  /** Containers freshly read from Google (Settings). */
  containersRefreshed: ["google", "containers", "refreshed"] as const,
  tasks: ["google", "tasks"] as const,
  taskList: (showCompleted: boolean) => ["google", "tasks", { showCompleted }] as const,
  events: ["google", "events"] as const,
  eventRange: (from: string, to: string, timeZone: string) =>
    ["google", "events", from, to, timeZone] as const,
}

/** The browser's IANA zone; personal event times are read and written in it. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * The signed-in person's Google connection. Errors (no server credentials,
 * server not ready) leave `data` empty, which every caller treats as "not
 * connected".
 */
export function useGoogleStatus() {
  return useQuery({
    queryKey: googleKeys.status,
    queryFn: getGoogleStatus,
    staleTime: 60_000,
    // Without server credentials this fails on every call; don't re-ask on each page.
    retryOnMount: false,
  })
}

/** True when Google UI should show: linked, and Google still lets Taskly in. */
export function isGoogleUsable(status: GoogleStatus | undefined): boolean {
  return Boolean(status?.configured && status.connected && status.state !== "revoked")
}

export function useGoogleConnected(): boolean {
  return isGoogleUsable(useGoogleStatus().data)
}

/** Connected, and their tasks sync with Google Tasks (switched on, and allowed). */
export function useGoogleTasks(): boolean {
  const status = useGoogleStatus().data
  return isGoogleUsable(status) && Boolean(status?.tasks)
}

/** A refused or missing connection changes what Settings shows; re-read it. */
function refreshStatusOn(queryClient: QueryClient, error: unknown) {
  if (
    error instanceof AppError &&
    (error.code === "googleReconnect" || error.code === "googleNotConnected")
  ) {
    void queryClient.invalidateQueries({ queryKey: googleKeys.status })
  }
}

/**
 * Pulls changes from Google. A sync can touch workspace tasks and meetings
 * too, so those are refreshed with the personal items.
 */
export function useSyncGoogleNow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (retryFailed: boolean) => syncGoogleNow(retryFailed),
    onSuccess: (status) => {
      queryClient.setQueryData(googleKeys.status, status)
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: googleKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: googleKeys.events }),
        // Not the Settings copy: that one is read fresh from Google once per visit.
        queryClient.invalidateQueries({ queryKey: googleKeys.containers, exact: true }),
        queryClient.invalidateQueries({ queryKey: taskKeys.all }),
        queryClient.invalidateQueries({ queryKey: meetingKeys.all }),
      ])
    },
    onError: () => queryClient.invalidateQueries({ queryKey: googleKeys.status }),
  })
}

export function useDisconnectGoogle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: disconnectGoogle,
    onSuccess: () => {
      // Personal items are gone with the connection; don't show stale copies.
      queryClient.removeQueries({ queryKey: googleKeys.tasks })
      queryClient.removeQueries({ queryKey: googleKeys.events })
      queryClient.removeQueries({ queryKey: googleKeys.containers })
      return queryClient.invalidateQueries({ queryKey: googleKeys.status })
    },
  })
}

/**
 * The person's calendars and task lists. `refresh` asks Google for the
 * current set first (Settings does this once each time it opens).
 */
export function useGoogleContainers({ refresh, enabled }: { refresh: boolean; enabled: boolean }) {
  return useQuery({
    queryKey: refresh ? googleKeys.containersRefreshed : googleKeys.containers,
    queryFn: () => listGoogleContainers(refresh),
    enabled,
    ...(refresh
      ? { refetchOnMount: "always" as const, refetchOnWindowFocus: false, staleTime: Infinity }
      : {}),
  })
}

export function useSetGoogleContainerSelected() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (v: { kind: GoogleContainerKind; id: string; selected: boolean }) =>
      setGoogleContainerSelected(v.kind, v.id, v.selected),
    onSuccess: (containers: GoogleContainer[]) => {
      queryClient.setQueryData(googleKeys.containersRefreshed, containers)
      queryClient.setQueryData(googleKeys.containers, containers)
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: googleKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: googleKeys.events }),
      ])
    },
    onError: (error) => refreshStatusOn(queryClient, error),
  })
}

// ---- Personal tasks --------------------------------------------------------

export function usePersonalTasks(showCompleted: boolean, enabled: boolean) {
  return useQuery({
    queryKey: googleKeys.taskList(showCompleted),
    queryFn: () => listPersonalTasks({ showCompleted }),
    enabled,
    placeholderData: keepPreviousData,
  })
}

export function useCreatePersonalTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: PersonalTaskInput) => createPersonalTask(null, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: googleKeys.tasks }),
    onError: (error) => refreshStatusOn(queryClient, error),
  })
}

type TaskPatch = { task: PersonalTask; patch: Partial<PersonalTaskInput> }

/** Applies the change on screen at once (ticking a box shouldn't wait for Google). */
export function useUpdatePersonalTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ task, patch }: TaskPatch) => updatePersonalTask(task.tasklistId, task.id, patch),
    onMutate: async ({ task, patch }: TaskPatch) => {
      await queryClient.cancelQueries({ queryKey: googleKeys.tasks })
      const previous = queryClient.getQueriesData<PersonalTask[]>({ queryKey: googleKeys.tasks })
      queryClient.setQueriesData<PersonalTask[]>({ queryKey: googleKeys.tasks }, (list) =>
        list?.map((t) => (t.id === task.id ? { ...t, ...patch } : t)),
      )
      return { previous }
    },
    onError: (error, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data)
      refreshStatusOn(queryClient, error)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: googleKeys.tasks }),
  })
}

export function useDeletePersonalTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (task: PersonalTask) => deletePersonalTask(task.tasklistId, task.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: googleKeys.tasks }),
    onError: (error) => refreshStatusOn(queryClient, error),
  })
}

// ---- Personal events -------------------------------------------------------

/** Events on the person's selected calendars overlapping `[from, to]` in this browser's zone. */
export function usePersonalEvents(range: { from: string; to: string }, enabled: boolean) {
  const timeZone = browserTimeZone()
  return useQuery({
    queryKey: googleKeys.eventRange(range.from, range.to, timeZone),
    queryFn: () => listPersonalEvents({ ...range, timeZone }),
    enabled,
    placeholderData: keepPreviousData,
  })
}

export function useCreatePersonalEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ calendarId, input }: { calendarId: string | null; input: PersonalEventInput }) =>
      createPersonalEvent(calendarId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: googleKeys.events }),
    onError: (error) => refreshStatusOn(queryClient, error),
  })
}

export function useUpdatePersonalEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (v: { calendarId: string; id: string; input: PersonalEventInput }) =>
      updatePersonalEvent(v.calendarId, v.id, v.input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: googleKeys.events }),
    onError: (error) => refreshStatusOn(queryClient, error),
  })
}

export function useDeletePersonalEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (v: { calendarId: string; id: string }) => deletePersonalEvent(v.calendarId, v.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: googleKeys.events }),
    onError: (error) => refreshStatusOn(queryClient, error),
  })
}

/** What adding a Google event to the current workspace would create (fills the meeting form). */
export function usePreviewGoogleEventImport() {
  const { accountId } = useWorkspace()
  return useMutation({
    mutationFn: ({ calendarId, eventId }: { calendarId: string; eventId: string }) =>
      previewGoogleEventImport(accountId, calendarId, eventId),
  })
}

/** Add a Google event to the current workspace: the meeting replaces it in Taskly's calendar. */
export function useAddGoogleEventToWorkspace() {
  const { accountId } = useWorkspace()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ calendarId, eventId, input }: { calendarId: string; eventId: string; input: MeetingInput }) =>
      addGoogleEventToWorkspace(accountId, calendarId, eventId, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: googleKeys.events }),
        queryClient.invalidateQueries({ queryKey: meetingKeys.all }),
      ]),
  })
}
