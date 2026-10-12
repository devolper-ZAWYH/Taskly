import { rpc } from "@/lib/api/rpc"
import type { FieldTranslation, MeetingMinutes, MinutesInput, MinutesScope, Page } from "@/lib/types"

export { canEditMinutes, canViewMinutes, canWriteMinutes } from "@/lib/permissions"
export type { MinutesInput } from "@/lib/types"

/** One meeting's minutes you can read: yours first. */
export const listMeetingMinutes = (accountId: string, meetingId: string): Promise<MeetingMinutes[]> =>
  rpc("listMeetingMinutes", accountId, meetingId)

/** Minutes across the workspace that you can read, newest meeting first. */
export const listMinutes = (
  accountId: string,
  params: { scope: MinutesScope; search: string; page: number; pageSize: number },
): Promise<Page<MeetingMinutes>> => rpc("listMinutes", accountId, params)

export const getMinutes = (accountId: string, id: string): Promise<MeetingMinutes> =>
  rpc("getMinutes", accountId, id)

/** Your minutes of a meeting (one set per person per meeting). */
export const createMinutes = (
  accountId: string,
  meetingId: string,
  input: MinutesInput,
): Promise<MeetingMinutes> => rpc("createMinutes", accountId, meetingId, input)

/** `expectedUpdatedAt`: the version being edited; a newer save is reported, not overwritten. */
export const updateMinutes = (
  accountId: string,
  id: string,
  input: MinutesInput,
  expectedUpdatedAt: string,
): Promise<MeetingMinutes> => rpc("updateMinutes", accountId, id, input, expectedUpdatedAt)

/** The minutes in the other language (Arabic ↔ English), on request; not stored. */
export const translateMinutes = (accountId: string, id: string): Promise<FieldTranslation> =>
  rpc("translateMinutes", accountId, id)

/** Whether a translation service is set up. */
export const getTranslationAvailable = (): Promise<boolean> => rpc("getTranslationAvailable")

export const deleteMinutes = (accountId: string, id: string): Promise<void> =>
  rpc("deleteMinutes", accountId, id)
