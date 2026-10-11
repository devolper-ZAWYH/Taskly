/**
 * Workspace meetings ↔ Google Calendar. The organiser and each attendee who
 * connected Google have a copy in their "Taskly · <Workspace>" calendar (no
 * Google attendees, so Google sends no invitations). Reconciled both ways
 * like tasks: three-way merge against the last agreed fields.
 */
import type { Meeting } from "@/lib/types"
import { actorFor, type Ctx } from "@/server/context"
import { calendarApi } from "@/server/google/apis"
import { googleFor, isGone, type Google } from "@/server/google/client"
import { containerGone } from "@/server/google/containers"
import {
  eventFields,
  eventPatchBody,
  googleEventBody,
  meetingFields,
  type GoogleEvent,
  type MeetingFields,
} from "@/server/google/mapping"
import { diff, restrict, threeWayMerge } from "@/server/google/merge"
import { connectedMembers, meetingFooter, noticeTo, workspaceZone } from "@/server/google/people"
import { enqueue, queueGoogleSync } from "@/server/google/queue"
import {
  deleteLink,
  getLink,
  linksFor,
  saveLink,
  workspaceContainer,
  type ContainerRow,
  type LinkRow,
} from "@/server/google/store"
import { eachPerson, isConnectionError } from "@/server/google/sync-tasks"
import {
  applyMeetingUpdate,
  createMeetingAs,
  deleteMeetingAs,
  findMeeting,
} from "@/server/services/meetings"

/** Administrators may change all of these from Google; members none (as in the app). */
const ADMIN_FIELDS = [
  "title",
  "notes",
  "date",
  "startTime",
  "endTime",
  "location",
] as const satisfies (keyof MeetingFields)[]

const meetingLink = (meeting: Meeting) =>
  `/w/${meeting.accountId}/calendar?view=week&date=${meeting.date}&meeting=${meeting.id}`

const idsOf = (meeting: Meeting) => ({ meetingId: meeting.id, accountId: meeting.accountId })

/** Bring every Google copy of this meeting in line: add, update, or remove. */
export async function syncMeeting(ctx: Ctx, accountId: string, meetingId: string): Promise<void> {
  const meeting = await findMeeting(ctx, accountId, meetingId)
  const links = await linksFor(ctx.db, "meeting", meetingId)
  const wanted = meeting
    ? await connectedMembers(ctx, accountId, [meeting.organizerId, ...meeting.attendeeIds])
    : []
  await eachPerson([
    ...links
      .filter((link) => !wanted.includes(link.user_id))
      .map((link) => () => removeMeetingCopy(ctx, link)),
    ...wanted.map((userId) => () =>
      syncMeetingCopy(ctx, userId, meeting!, links.find((link) => link.user_id === userId) ?? null),
    ),
  ])
}

async function removeMeetingCopy(ctx: Ctx, link: LinkRow): Promise<void> {
  try {
    const g = await googleFor(ctx, link.user_id)
    await calendarApi.delete(g, link.container_id, link.google_id)
  } catch (error) {
    if (!isGone(error) && !isConnectionError(error)) throw error
  }
  await deleteLink(ctx.db, link)
}

/**
 * Reconcile one person's copy. `remote`: the event as just listed by a pull
 * (null = deleted/cancelled in Google); leave it out to fetch it.
 */
export async function syncMeetingCopy(
  ctx: Ctx,
  userId: string,
  meeting: Meeting,
  link: LinkRow | null,
  remote?: GoogleEvent | null,
): Promise<void> {
  const g = await googleFor(ctx, userId)
  const container = await workspaceContainer(ctx.db, userId, "calendar", meeting.accountId)
  if (!container) {
    await enqueue(ctx, [{ kind: "setup_member", userId, accountId: meeting.accountId }], {
      drain: false,
    })
    return
  }
  if (!link || link.container_id !== container.google_id) {
    await insertCopy(ctx, g, container, userId, meeting)
    return
  }

  if (remote === undefined) {
    remote = await calendarApi.get(g, link.container_id, link.google_id).catch((error) => {
      if (isGone(error)) return null
      throw error
    })
  }
  if (!remote || remote.status === "cancelled") {
    await copyDeleted(ctx, userId, meeting, link, container)
    return
  }

  const zone = await workspaceZone(ctx, meeting.accountId, meeting.organizerId)
  const base = JSON.parse(link.base) as MeetingFields
  const actor = await actorFor(ctx, userId, meeting.accountId)
  // Null when someone made the copy all-day, multi-day or repeating: put ours back.
  const actual = eventFields(remote, zone)
  const theirs = actual ? { ...actual, title: actual.title || base.title } : base
  const { remote: permitted, blocked } = restrict(
    base,
    theirs,
    actor?.role === "administrator" ? ADMIN_FIELDS : [],
  )
  const merged = threeWayMerge(
    base,
    meetingFields(meeting),
    permitted,
    meeting.updatedAt >= (remote.updated ?? ""),
  )

  let current = meeting
  if (actor && Object.keys(merged.toLocal).length > 0) {
    current = await applyMeetingUpdate(ctx, actor, meeting, {
      ...merged.value,
      attendeeIds: meeting.attendeeIds,
    })
    await queueGoogleSync(ctx, "meeting", meeting.accountId, meeting.id, { drain: false })
  }

  const footer = await meetingFooter(ctx, current, userId)
  const footerText = footer.join("\n")
  const needsPatch =
    !actual || Object.keys(diff(actual, merged.value)).length > 0 || footerText !== link.footer
  let etag = remote.etag ?? null
  if (needsPatch) {
    const patched = await calendarApi.patch(
      g,
      container.google_id,
      link.google_id,
      eventPatchBody(merged.value, zone, footer, idsOf(current)),
    )
    etag = patched.etag ?? null
  }
  await saveLink(ctx.db, {
    ...link,
    etag,
    base: JSON.stringify(merged.value),
    footer: footerText,
  })
  if (blocked.length > 0 || !actual) {
    await noticeTo(ctx, userId, "google_change_reverted", {
      accountId: meeting.accountId,
      title: current.title,
      link: meetingLink(current),
    })
  }
}

async function insertCopy(
  ctx: Ctx,
  g: Google,
  container: ContainerRow,
  userId: string,
  meeting: Meeting,
): Promise<void> {
  const zone = await workspaceZone(ctx, meeting.accountId, meeting.organizerId)
  const fields = meetingFields(meeting)
  const footer = await meetingFooter(ctx, meeting, userId)
  let created: GoogleEvent
  try {
    created = await calendarApi.insert(
      g,
      container.google_id,
      googleEventBody(fields, zone, footer, idsOf(meeting)),
    )
  } catch (error) {
    if (!isGone(error)) throw error
    await containerGone(ctx, container)
    return
  }
  await saveLink(ctx.db, {
    kind: "meeting",
    entity_id: meeting.id,
    user_id: userId,
    account_id: meeting.accountId,
    container_id: container.google_id,
    google_id: created.id,
    etag: created.etag ?? null,
    base: JSON.stringify(fields),
    footer: footer.join("\n"),
  })
}

/**
 * Their copy was deleted in Google. The organiser, if an administrator,
 * deletes the meeting in Taskly; anyone else gets the copy back, with a notice.
 */
async function copyDeleted(
  ctx: Ctx,
  userId: string,
  meeting: Meeting,
  link: LinkRow,
  container: ContainerRow,
): Promise<void> {
  await deleteLink(ctx.db, link)
  const actor = await actorFor(ctx, userId, meeting.accountId)
  if (actor?.role === "administrator" && meeting.organizerId === userId) {
    await deleteMeetingAs(ctx, actor, meeting)
    await queueGoogleSync(ctx, "meeting", meeting.accountId, meeting.id, { drain: false })
    return
  }
  await insertCopy(ctx, await googleFor(ctx, userId), container, userId, meeting)
  await noticeTo(ctx, userId, "google_item_restored", {
    accountId: meeting.accountId,
    title: meeting.title,
    link: meetingLink(meeting),
  })
}

/**
 * An event someone added to their "Taskly · <Workspace>" calendar in Google.
 * An administrator's single-day timed event becomes a meeting they organise;
 * anything else moves to their primary calendar, with a notice.
 */
export async function importEvent(
  ctx: Ctx,
  userId: string,
  container: ContainerRow,
  event: GoogleEvent,
): Promise<void> {
  const accountId = container.account_id!
  const g = await googleFor(ctx, userId)

  // Tagged by Taskly but not linked (created twice at once, or a lost link):
  // adopt it if this person has no copy yet, otherwise delete the duplicate.
  const tagged = event.extendedProperties?.private?.tasklyMeetingId
  if (tagged) {
    const meeting = await findMeeting(ctx, accountId, tagged)
    const wanted =
      meeting && (meeting.organizerId === userId || meeting.attendeeIds.includes(userId))
    if (wanted && !(await getLink(ctx.db, "meeting", meeting.id, userId))) {
      await saveLink(ctx.db, {
        kind: "meeting",
        entity_id: meeting.id,
        user_id: userId,
        account_id: accountId,
        container_id: container.google_id,
        google_id: event.id,
        etag: event.etag ?? null,
        base: JSON.stringify(meetingFields(meeting)),
        footer: "",
      })
      await queueGoogleSync(ctx, "meeting", accountId, meeting.id, { drain: false })
      return
    }
    await calendarApi.delete(g, container.google_id, event.id).catch((error) => {
      if (!isGone(error)) throw error
    })
    return
  }

  const actor = await actorFor(ctx, userId, accountId)
  const zone = await workspaceZone(ctx, accountId, userId)
  const fields = eventFields(event, zone)
  if (actor?.role !== "administrator" || !fields) {
    try {
      await calendarApi.move(g, container.google_id, event.id, "primary")
    } catch (error) {
      if (isGone(error)) return
      throw error
    }
    if (actor) await noticeTo(ctx, userId, "google_event_moved", { accountId, title: event.summary ?? "" })
    return
  }

  const meeting = await createMeetingAs(ctx, actor, {
    ...fields,
    title: fields.title || "Untitled",
    attendeeIds: [],
  })
  const value = meetingFields(meeting)
  const footer = await meetingFooter(ctx, meeting, userId)
  const patched = await calendarApi.patch(
    g,
    container.google_id,
    event.id,
    eventPatchBody(value, zone, footer, idsOf(meeting)),
  )
  await saveLink(ctx.db, {
    kind: "meeting",
    entity_id: meeting.id,
    user_id: userId,
    account_id: accountId,
    container_id: container.google_id,
    google_id: event.id,
    etag: patched.etag ?? null,
    base: JSON.stringify(value),
    footer: footer.join("\n"),
  })
}
