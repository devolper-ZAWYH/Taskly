import { rpc } from "@/lib/api/rpc"
import type { Meeting, MeetingInput, MeetingOption, Task } from "@/lib/types"

export { canCreateMeeting, canEditMeeting } from "@/lib/permissions"
export type { MeetingInput } from "@/lib/types"

/** Meetings on days in `[from, to]` (YYYY-MM-DD) that the user may see. */
export const listMeetings = (
  accountId: string,
  params: { from: string; to: string },
): Promise<Meeting[]> => rpc("listMeetings", accountId, params)

/** Run a meeting's title/agenda translation again (administrators). */
export const retranslateMeeting = (accountId: string, id: string): Promise<Meeting> =>
  rpc("retranslateMeeting", accountId, id)

export const getMeeting = (accountId: string, id: string): Promise<Meeting> =>
  rpc("getMeeting", accountId, id)

/** Action items: tasks created from this meeting. */
export const listMeetingTasks = (accountId: string, meetingId: string): Promise<Task[]> =>
  rpc("listMeetingTasks", accountId, meetingId)

/** Meetings a task can be related to, newest first. */
export const listMeetingOptions = (accountId: string): Promise<MeetingOption[]> =>
  rpc("listMeetingOptions", accountId)

export const createMeeting = (accountId: string, input: MeetingInput): Promise<Meeting> =>
  rpc("createMeeting", accountId, input)

export const updateMeeting = (accountId: string, id: string, input: MeetingInput): Promise<Meeting> =>
  rpc("updateMeeting", accountId, id, input)

/** Deletes the meeting; its action-item tasks and minutes stay but lose the link. */
export const deleteMeeting = (accountId: string, id: string): Promise<void> =>
  rpc("deleteMeeting", accountId, id)
