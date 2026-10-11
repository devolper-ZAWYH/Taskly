# Plan: Two-way Google Calendar + Google Tasks sync

Status: **implemented** (2026-10-11) on top of commit `85b2280`. Phase 6
hardening, the workspace time zone and the permission tests were added the
same day. Section 11 lists where the build differs from this plan and which
defaults were chosen for the open decisions. Agenda translation is a separate plan:
[plan-agenda-translation.md](plan-agenda-translation.md).

## 1. What this does

Every person connects **their own** Google account. From then on there are two kinds
of items, and **both sync in both directions**:

|                         | Workspace items                                                        | Personal items                                                  |
| ----------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| What they are           | Taskly tasks assigned to you; Taskly meetings you organise or attend   | Your own Google Calendar events and Google Tasks                |
| Source of truth         | Taskly                                                                 | Google                                                          |
| Where they live in Google | Your **"Taskly · <Workspace>"** task list and calendar, one pair per workspace | Where they already are (your calendars and task lists)          |
| Who sees them in Taskly | Same rules as today (`lib/permissions.ts`)                             | **Only you**                                                    |
| Edit in Taskly          | Every person's Google copy updates                                     | Written straight to Google                                      |
| Edit in Google          | The Taskly item updates if your role allows it, then everyone else's copies update | Taskly shows the change                                         |
| Create in Google        | A new workspace task or meeting, if your role allows it (§5.4)         | Shows up in Taskly                                              |

So each person has their own tasks and meetings in one place: the shared work from
every workspace they belong to, plus their private Google items. Taskly and Google
show the same thing whichever side the change was made on.

## 2. Where the Google agent skills (`gws`) fit

The official `googleworkspace/cli` agent skills (v0.22.5) are installed in
`.claude/skills/`: Calendar, Tasks, workflow helpers, recipes, and two personas. The
`gws` binary is installed globally (`npm i -g @googleworkspace/cli`).

`gws` is a CLI binary, so it **cannot run inside the Cloudflare Worker**; the app
calls Calendar API v3 and Tasks API v1 directly with `fetch`. The skills are tools
for whoever builds and runs Taskly, including Claude:

| Use                         | Skill / command                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Learn the real payloads     | `gws schema calendar.events.patch`, `gws schema tasks.tasks.patch`, `gws calendar +agenda --week`                                   |
| Make changes on the Google side in tests | `gws tasks tasks patch …`, `gws calendar events patch …`, `gws calendar +insert …`, `recipe-reschedule-meeting`        |
| Verify the other direction  | After a Taskly change: `gws tasks tasks list --params '{"tasklist":"<id>"}'`, `gws calendar +agenda --calendar "Taskly · Acme Consulting"` |
| Check drift                 | `recipe-review-overdue-tasks`, compared with Taskly's overdue filter                                                                |
| Agent workflows (optional)  | `gws workflow +standup-report` / `+meeting-prep` alongside Taskly's dashboard for a daily brief                                     |

**One-time `gws` sign-in.** You do this yourself because it needs your Google
account:

1. In the Google Cloud Console, create a project (for example `taskly-dev`) and
   enable the **Google Calendar API** and the **Google Tasks API**.
2. Set the OAuth consent screen to External with Testing status, and add yourself
   as a test user.
3. Create an OAuth client of type **Desktop app** and save its JSON as
   `%USERPROFILE%\.config\gws\client_secret.json`.
4. Run `gws auth login -s calendar,tasks`.

The app itself needs a separate OAuth client of type **Web application** in the same
project (§6.1).

## 3. Constraints found in the code

- **Runtime.**
  - This is a Cloudflare Worker (OpenNext), so `fetch` is the only option. Don't pull
    in the `googleapis` Node SDK; write a small typed client instead.
  - `global_fetch_strictly_public` is on, which is fine for Google.
- **Services assume a signed-in browser.**
  - `updateTask`, `createMeeting` and the other write functions start with
    `requireWorkspace(ctx, …)`, which reads the session cookie.
  - Changes arriving from Google have no session. Split each write into an RPC
    wrapper and an internal function such as
    `applyTaskUpdate(ctx, actor, current, patch)`.
  - Add `actorFor(ctx, userId, accountId)` to `server/context.ts`. It builds an
    `Actor` from a membership and runs the same checks.
  - Both paths then share validation, permissions, notifications and fan-out.
- **Times have no time zone.**
  - Meetings and tasks store a wall-clock `date` plus `HH:MM`, but Google needs a
    zone.
  - Proposal: add `accounts.timezone` (the workspace's time zone, defaulting to the
    creator's `users.timezone`) and use it in both directions.
  - *Decision needed (§10).*
- **Taskly meetings are single-day, timed and non-recurring.**
  - A Google event that is all-day, spans several days, or repeats can't become a
    Taskly meeting (§5.4).
- **Membership changes matter.**
  - `members.removeMember`, `platform.detachUser`, `platform.deleteUser`,
    deactivation and role changes must update or remove that person's Google copies
    for the workspace.
  - A role change also changes what that person may edit from Google.
- **Hard deletes.**
  - `deleteTask` and `deleteMeeting` must read the assignees and attendees *before*
    the `DELETE`.
- **Operators.**
  - Operators who enter a workspace without a membership get no Google copies of it.
  - Sync follows `memberships` only.
- **Cron.**
  - `custom-worker.ts` already has a `scheduled` handler (`0 * * * *`).
  - Add `*/5 * * * *` for Tasks polling, retries and channel renewal, and branch on
    `controller.cron`.

## 4. Google API facts that shape the design

- **Tasks API.**
  - `due` is **date only**; Google discards the time.
  - Status is only `needsAction` or `completed`.
  - There is no custom-metadata field, so ID mapping lives in D1.
  - There are **no push notifications**, so Taskly polls with `updatedMin`.
  - Subtasks exist (`parent`); Taskly has none, so they're shown flat.
- **Calendar API.**
  - `events.watch` push channels give near-real-time inbound changes. They expire, so
    the cron renews them.
  - Incremental reads use `syncToken`; a `410 Gone` means a full resync.
  - `syncToken` can't be combined with `timeMin`/`timeMax`.
  - Verify `X-Goog-Channel-Token` on every webhook.
  - Tag Taskly-made events with `extendedProperties.private`
    (`tasklyMeetingId`, `tasklyAccountId`).
- **OAuth.**
  - While the consent screen is in **Testing**, refresh tokens **expire after 7
    days**, with at most 100 test users.
  - Publish the app before real users connect. Anyone who connected during Testing
    must reconnect.
  - These scopes are "sensitive", so production needs Google's app verification.
- **Scopes:**
  - `openid email`
  - `https://www.googleapis.com/auth/tasks` (read/write all task lists)
  - `https://www.googleapis.com/auth/calendar.app.created` (create the
    "Taskly · <Workspace>" calendars)
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (list the
    person's calendars)
  - `https://www.googleapis.com/auth/calendar.events` (read/write events on personal
    calendars)
  - Check the current scope list in the Cloud Console before you build. If a narrower
    "owned calendars only" events scope is available, prefer it.
- **Quota.**
  - Tasks polling costs about `people × lists × 288` calls a day at 5-minute
    intervals.
  - The Tasks API has a much smaller default daily quota than Calendar. Check it in
    the Console.
  - Poll less often (every 30 minutes) for people who haven't opened Taskly in a day.

## 5. Sync rules

### 5.1 Containers in each person's Google account

- **One task list and one calendar per workspace**, named
  `Taskly · <Workspace name>`, created when the person connects or joins a
  workspace. Per-workspace containers (rather than one shared "Taskly" calendar) let
  a task or event *created* in Google land in the right workspace.
- **Personal containers:** the person's own calendars and task lists. By default,
  the primary calendar and the default list ("My Tasks") are shown. Others are
  opt-in under Settings.

### 5.2 Field mapping, both ways

Workspace tasks:

| Taskly                                   | Google Task                                  | → Google | ← Google                               |
| ---------------------------------------- | -------------------------------------------- | -------- | -------------------------------------- |
| `title`                                  | `title`, shown as `T-12 · title`             | ✓        | ✓ (prefix stripped)                    |
| `description`                            | `notes`, above the Taskly footer              | ✓        | ✓                                      |
| `due_date`                               | `due` (date only)                            | ✓        | ✓; Taskly keeps its `due_time`        |
| open / in_progress / on_hold ↔ completed | `needsAction` ↔ `completed`                  | ✓        | ✓; reopening in Google sets `open`    |
| `due_time`, priority, assignees, start, related meeting | Taskly footer in `notes` (read-only) | ✓        | – (change these in Taskly)             |
| cancelled                                | the copy is deleted                           | ✓        | –                                      |

Workspace meetings:

| Taskly                          | Google event                                         | → Google | ← Google                          |
| ------------------------------- | ---------------------------------------------------- | -------- | --------------------------------- |
| `title`                         | `summary`                                            | ✓        | ✓                                 |
| `date`, `start_time`, `end_time` | `start` / `end` + workspace `timeZone`               | ✓        | ✓ (must stay single-day and timed) |
| `location`                      | `location`                                           | ✓        | ✓                                 |
| `notes` (agenda)                | `description`, above the Taskly footer                | ✓        | ✓                                 |
| organiser, attendees            | Taskly footer, not Google attendees (no invite emails) | ✓        | – (change these in Taskly)        |

**The Taskly footer.** Everything from a line reading `⸻ Taskly ⸻` downward is
generated by Taskly. It holds the due time, priority, people, agenda translations
and an "Open in Taskly" link. Inbound sync ignores it, so people can't break
anything by editing it.

### 5.3 Who may change a workspace item from Google

Inbound changes are applied **as that person** through the same rules as the app:

| Change made in Google                    | Administrator in that workspace         | Member                                              |
| ---------------------------------------- | --------------------------------------- | --------------------------------------------------- |
| Tick or untick a task                    | ✓ applied                               | ✓ applied (members may change status)               |
| Task title, notes or due date            | ✓ applied                               | ✗ reverted, with a notice in the bell               |
| Meeting title, time, location or agenda  | ✓ applied                               | ✗ reverted, with a notice                           |
| New task in `Taskly · <Workspace>`       | ✓ becomes their own private task (§11)  | ✓ becomes their own private task (§11)              |
| New event in `Taskly · <Workspace>`      | ✓ becomes a new meeting they organise   | Moved to their primary calendar, with a notice      |
| Delete a task or event copy              | See decision §10.2                      | Recreated, with a notice                            |

An applied change behaves exactly like an edit in the app. Other people get the
usual notifications ("Aisha changed …") and their Google copies update.

### 5.4 Creating and deleting, both directions

| Action                                                    | Result                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Taskly task/meeting created, assigned or invited          | A copy appears in each connected person's `Taskly · <Workspace>` list or calendar                       |
| Taskly task cancelled or deleted, person unassigned, meeting deleted, attendee removed | That copy is deleted                                                    |
| Person leaves the workspace or is deactivated             | Their `Taskly · <Workspace>` list and calendar are deleted                                               |
| Admin creates a timed single-day event in `Taskly · <Workspace>` | A new Taskly meeting, organised by them, with no attendees until they add some in Taskly           |
| Event in `Taskly · <Workspace>` that is all-day, multi-day or recurring | Moved to their primary calendar (`events.move`), with a notice. It stays a personal event.  |
| Personal item created, edited or deleted in Taskly        | Written to Google immediately; the person sees an error if Google refuses                                |
| Personal item created, edited or deleted in Google        | Taskly shows it on the next sync (§5.6)                                                                  |

Personal recurring events show as individual occurrences. Editing one in Taskly
changes that occurrence only; "Edit series" opens Google Calendar.

### 5.5 Conflicts

Each link stores a **base**: the field values both sides agreed on at the last sync.
When a change comes in, Taskly compares base, Taskly's current values and Google's
current values (a three-way merge):

- A field changed on one side only is copied to the other side.
- A field changed on both sides goes to the **newer** change, comparing Taskly's
  `updated_at` with Google's `updated`. The losing value is logged.
- Fields from different sides merge. For example, a title edited in Google and a
  due date edited in Taskly both survive.

**Loop guard.** After every write, the stored `etag` and base are updated. An inbound
change whose `etag` matches is Taskly's own write coming back, so it is skipped. A
push whose payload equals the base is skipped too.

### 5.6 When sync runs

| Trigger                                   | Typical delay      |
| ----------------------------------------- | ------------------ |
| Change in Taskly → Google                 | Seconds. The job is queued and drained with `ctx.waitUntil`. |
| Change in Google Calendar → Taskly        | Seconds to a minute, via a push channel and the webhook.     |
| Change in Google Tasks → Taskly           | Up to 5 minutes from the cron poll. Also polled when the person opens Taskly (if more than 60 s since the last poll), and with a **Sync now** button. |
| Retries, channel renewal                  | 5-minute cron, with backoff of 1 m, 5 m, 30 m, then 2 h before a job is marked failed. |

## 6. Design

### 6.1 Config and secrets

| Name                   | Kind   | Purpose                                              |
| ---------------------- | ------ | ---------------------------------------------------- |
| Google Client ID / secret | Platform → Settings (or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) | OAuth web client |
| `ENCRYPTION_KEY`       | secret | AES-GCM 256 key that encrypts refresh tokens (and console secrets) at rest; was `GOOGLE_TOKEN_KEY` |
| App address            | Platform → Settings (or `APP_ORIGIN`) | Public URL: footer links, and the push webhook (https only) |
| `GOOGLE_API_ORIGIN`, `GOOGLE_OAUTH_ORIGIN` | dev only | Point at `scripts/google-mock.mjs` for local testing |

Redirect URIs are `<app address>/api/google/callback`; Platform → Settings
shows the exact one. Locally the values can live in `.dev.vars`.

### 6.2 Schema: `migrations/0007_google_sync.sql`

See the migration file. It has five parts:

- `google_connections`: one row per person, with encrypted refresh and access
  tokens, a state, and the last sync and last seen times.
- `google_containers`: the person's task lists and calendars. `account_id` is
  set on a workspace's "Taskly · …" pair and empty on personal ones. Rows also
  hold the sync token or poll cursor, the push channel, and the calendar's
  access role.
- `google_links`: one row per workspace item, person and Google copy. It
  stores the three-way merge base and the footer last written.
- `google_sync_jobs`: the outbox. Each row has a dedupe key, a version, a lock,
  and backoff fields.
- `accounts.timezone`: a new column.

### 6.3 Server modules

- **`server/google/oauth.ts`**: consent URL with PKCE and a `state` bound to the
  session hash; code exchange; refresh; revoke; AES-GCM encrypt and decrypt (same
  style as `server/crypto.ts`).
- **`server/google/client.ts`**: the `fetch` wrapper. It adds the access token,
  retries 429 and 5xx, and on `invalid_grant` marks the connection `revoked` and
  notifies the person.
- **`server/google/mapping.ts`**: *pure* functions between Taskly shapes and Google
  shapes, both directions. Also writes and strips the Taskly footer.
- **`server/google/merge.ts`**: *pure* three-way merge. It takes base, Taskly and
  Google values and returns per-side patches.
- **`server/google/outbound.ts`**: fan-out from workspace writes into
  `google_sync_jobs`; `drain(ctx, limit)`.
- **`server/google/inbound.ts`**:
  - `pullContainer` runs a Calendar `syncToken` read or a Tasks `updatedMin` read.
  - It applies changes to linked items with `actorFor()`, the merge, and the
    internal service functions.
  - It imports new items and reverts changes the person isn't allowed to make.
- **`server/google/personal.ts`**: create, edit and delete of personal tasks and
  events, straight against Google, plus the caches.
- **`server/services/google.ts`** (RPC methods):
  - Connection: `getGoogleStatus`, `syncGoogleNow`, `disconnectGoogle`.
  - Containers: `listGoogleContainers`, `setGoogleContainerSelected`.
  - Personal tasks: `listPersonalTasks`, `createPersonalTask`, `updatePersonalTask`,
    `deletePersonalTask`.
  - Personal events: `listPersonalEvents(from, to)`, `createPersonalEvent`,
    `updatePersonalEvent`, `deletePersonalEvent`.
- **Route handlers** (OAuth needs GET redirects):
  - `app/api/google/connect/route.ts`
  - `app/api/google/callback/route.ts`
  - `app/api/google/webhook/route.ts`, which receives Calendar pushes and queues
    `pull_container`.
- **Refactor** of `server/services/tasks.ts` and `meetings.ts`: split each write into
  an RPC wrapper and an internal function. Call `outbound.enqueue…` from the internal
  functions, next to `notify()`, so changes from the app and from Google both fan
  out.
- **New notification events** in `server/services/notifications.ts`:
  `google_change_reverted`, `google_item_moved` and `google_reconnect`, grouped under
  a new `google_sync` preference kind.

### 6.4 UI

- **Settings → Connected accounts**:
  - Connect Google, the connected email, last sync time, and errors such as
    "Reconnect needed".
  - Checkboxes for which personal calendars and task lists to show, a **Sync now**
    button, and Disconnect.
- **Calendar**:
  - Personal events appear in each workspace's calendar for their owner only, in a
    distinct colour with a Google mark.
  - Clicking one opens an editable panel. Saving writes to Google.
  - "New meeting" gets a **Where** select: `<Workspace>` or `Personal (Google)`.
    Members only see Personal, because they can't create workspace meetings.
- **Tasks**: a **Personal** tab lists the person's selected Google Tasks, with
  create, edit, complete and delete. Members can use it too.
- **Dashboard**: the "mine" section also includes personal tasks due today or
  overdue, and today's personal events.
- **Workspace items**: a small "Synced to Google" mark when the viewer is connected.
- **Strings**: add everything to both `messages/en.ts` and `messages/ar.ts`.

## 7. Interaction with agenda translation (if that plan ships)

- **Outbound**: `mapping.ts` puts the `done` translations inside the Taskly footer of
  the event description. When a translation finishes, the translation code queues
  `push_meeting` for that meeting's connected people.
- **Inbound**: because translations live in the footer, an admin editing the agenda
  in Google changes only the original text. That edit reaches `notes` through the
  same internal update function, which queues re-translation.
- Personal Google events are not translated (v1).

Neither plan needs the other to ship first.

## 8. Roadmap

| #  | Phase                                 | Main work                                                                                                       | Depends on |
| -- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| 0  | Local setup                           | ✅ Done: install, migrate, seed, dev server, `gws` and skills                                                    | –          |
| 1  | Foundations                           | Cloud project, OAuth client, secrets, `0007`, connect/callback/disconnect, token encryption, outbox + 5-minute cron, service refactor + `actorFor` | –          |
| 2  | Workspace tasks, both ways            | Per-workspace task lists, push, polling, merge, permission reverts, create/delete rules                         | 1          |
| 3  | Workspace meetings, both ways         | Per-workspace calendars, `accounts.timezone`, push, webhook + `syncToken`, merge, reverts, create/move rules    | 1          |
| 4  | Personal Google Tasks in Taskly       | Container picker, cache + polling, Personal tab with create, edit, complete and delete, dashboard               | 1          |
| 5  | Personal Google Calendar in Taskly    | Read-through cache + webhook invalidation, calendar rendering, create/edit/delete, "Where" select               | 1          |
| 6  | Hardening and launch                  | Publish the OAuth app and pass verification, quota and adaptive polling, alerts on failed jobs, reconnect flow. Code done (§11); publishing and verification are manual steps in Google Cloud | all        |

Phases 2–5 only depend on phase 1 and can be built in any order. Phase 2 has the most
value per effort.

## 9. Testing

- **Unit tests**: `mapping.ts` (both directions, footer round-trip) and `merge.ts`
  (one-sided, both-sided and mixed-field changes). Both are pure; add `vitest` if a
  test runner is wanted.
- **Permission matrix**: one test per row of §5.3, for an administrator and for a
  member.
- **Locally**:
  - OAuth works on `localhost:3100`.
  - Calendar webhooks need a public URL: use a `cloudflared` tunnel or a preview
    deploy.
  - Cron: `wrangler dev --test-scheduled` and
    `curl "localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.
- **Both directions with `gws`**:
  - Change a task or meeting in Taskly, then check it with `gws tasks tasks list` /
    `gws calendar +agenda --calendar "Taskly · Acme Consulting"`.
  - Change it with `gws tasks tasks patch` / `gws calendar events patch`, run the
    poll (or wait for the webhook), and check Taskly.
  - Edit the same field on both sides between syncs and confirm the newer change
    wins.
  - As a member, edit a title in Google and confirm it is reverted with a notice.

## 10. Decisions needed

1. **Time zone for Google events**: a new workspace time zone (recommended), or the
   organiser's own zone?
2. **Deleting a workspace item's copy in Google.** Recommended: if an administrator
   deletes a task they created, or a meeting they organise, it is deleted in Taskly.
   Any other delete is recreated, with a notice. The alternative is that deleting
   always means "remove me from it".
3. **Member edits from Google**: revert, with a notice (recommended; matches Taskly
   roles)? Or let members change due dates on their own tasks?
4. **Personal containers shown by default**: primary calendar and "My Tasks" only
   (recommended), or all of them?
5. **On disconnect**: delete the `Taskly · <Workspace>` calendars and task lists from
   Google (recommended), or leave them as a snapshot? Personal items are never
   touched.

## 11. As built

**Differences from the plan above:**

- **Personal items are live.** Personal Google Tasks and events are read and
  written straight against Google on each request (`server/google/personal.ts`).
  Taskly doesn't store them. That removed the planned cache tables and the
  polling of personal lists. Google is their source of truth, so nothing can
  drift.
- **One reconcile path per item.** Changes coming from Taskly (a `sync_task` or
  `sync_meeting` job) and from Google (a `pull` job) go through the same
  function, `syncTaskCopy` / `syncMeetingCopy`. That function does
  read → three-way merge → apply → patch.
- **Writes are split.** Task and meeting writes are now an RPC wrapper plus an
  internal function: `createTaskAs`, `applyTaskUpdate`, `deleteTaskAs`,
  `createMeetingAs`, `applyMeetingUpdate` and `deleteMeetingAs`. Google
  changes are applied as that person through `actorFor()`, with the app's own
  permission checks and notifications.
- **Leftover copies are adopted or removed.** A Google copy Taskly made but
  lost the link for (for example, two runs created it at once) is recognised
  by its `T-n ·` title plus footer, or by the event's `tasklyMeetingId` tag.
  It is then adopted or deleted, never imported as a new item.
- **Deactivating or deleting a user** disconnects their Google account. That
  removes their "Taskly · …" lists and calendars and revokes Taskly's access.
- **"Sync now"** also runs pending task and meeting syncs. Locally there is no
  cron, so this is how queued work catches up.

**Defaults chosen for §10** (the user didn't pick):

1. **Time zone:** `accounts.timezone` is used if set. Otherwise the meeting's
   organiser's zone, then UTC. Operators set it in Platform → Accounts.
   Changing it queues a sync of every linked meeting, so the Google copies
   keep their wall-clock times in the new zone. Each link stores the zone its
   copy was written in (`0008_google_link_zone.sql`), and inbound sync reads
   the copy in that zone. A zone change (including an organiser's browser zone
   changing) therefore never looks like someone moved the event in Google.
2. **Deleting a copy in Google:** if an administrator deletes a task they
   created, or a meeting they organise, it is deleted in Taskly. Any other
   delete is recreated, with a notice.
3. **Member edits from Google:** undone, with a notice. Members can only
   tick a task done or not done.
4. **Personal containers shown by default:** the primary calendar and the
   default task list.
5. **On disconnect:** the "Taskly · …" lists and calendars are deleted from
   Google. Personal items are untouched.

**Hardening (phase 6):**

- **Failed jobs:** when a job stops retrying, every operator gets a
  `google_sync_failed` notification (at most one an hour, under their "Google
  sync" preference). It links to **Platform → Google sync**
  (`server/google/health.ts`), which shows counts, failing work with its last
  error, and people who must reconnect, plus a **Retry failed** button.
  The **Sync now** button (not the pull when the app opens) also retries the
  person's own stopped jobs, and Settings says when some of their changes
  couldn't reach Google.
- **Quota and polling:** 429/5xx and rate-limit 403s are retried. Workspace
  lists are polled every 5 minutes for people active in the last day, and
  every 30 minutes otherwise. Calendars with a live push channel get a safety
  pull every 6 hours.
- **Reconnect:** `invalid_grant` marks the connection revoked and notifies the
  person. Settings offers **Reconnect**.
- **Still manual:** publish the OAuth consent screen and pass Google's
  verification for the Calendar and Tasks scopes (README, Google setup step 4).

**Private tasks** (`0009_private_tasks.sql`, added 2026-10-12):

- Anyone can create a task only they can see. Its creator is its only
  assignee, and they can change every field from Taskly or Google.
- A private task is copied to Google only while its **Sync to Google Tasks**
  switch is on. Turning the switch off removes the copy.
- A task anyone adds to their `Taskly · <Workspace>` list becomes their
  private task (synced). This replaces the §5.3 row where an administrator's
  became a workspace task and a member's was moved.
- Deleting the copy of your own private task in Google deletes it in Taskly.
- The Tasks page's old **Personal** tab (Google Tasks) is now a section under
  **Mine**.

**Testing:**

- `yarn test` runs the unit tests for mapping, merge, and the §5.3
  permission matrix (`policy.test.ts`, one test per row for an administrator
  and a member).
- `scripts/google-mock.mjs` is an in-memory Google (OAuth, Tasks, Calendar)
  for local end-to-end runs without a Google Cloud project.
