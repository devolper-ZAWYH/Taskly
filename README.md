# Taskly

A multi-workspace task management app (English + Arabic/RTL), running on
Cloudflare Workers with a D1 (SQLite) database. The Next.js app is both the
frontend and the backend: there is no separate server.

## Run locally

```bash
yarn install
yarn db:migrate:local   # create the local D1 tables (.wrangler/state)
yarn db:seed:local      # load the sample workspaces (once, on an empty DB)
yarn dev                # http://localhost:3100
```

Checks: `yarn lint`, `yarn typecheck`, `yarn build`.

## Local sample accounts

Created by `yarn db:seed:local`. The live site was seeded with
`--random-passwords`, so these passwords **don't** work there.

| Who               | Email                | Password       | Workspaces                                         |
| ----------------- | -------------------- | -------------- | -------------------------------------------------- |
| Platform operator | operator@example.com | operator1234   | Platform console, plus access to every workspace   |
| Aisha             | admin@example.com    | admin1234      | Acme: Administrator · Northwind: Member            |
| Omar              | omar@example.com     | member1234     | Acme: Member                                       |
| Sara              | sara@example.com     | member1234     | Acme: Member · Northwind: Administrator            |
| Daniel            | daniel@example.com   | member1234     | Acme: Member                                       |

## Deploy

```bash
yarn db:migrate:remote  # apply new files in migrations/ to the live database
yarn deploy             # build and upload the Worker
```

Schema changes go in a new numbered file in `migrations/`; never edit one
that has already been applied. Run `yarn cf-typegen` after changing
`wrangler.jsonc`.

To seed a fresh live database:
`node scripts/seed.mjs --out seed.sql --random-passwords`, then
`wrangler d1 execute DB --remote --file seed.sql`. The new passwords are
printed once.

## Data, sign-in and security

- All data lives in D1 (`zawyh-db`, binding `DB`). Each browser keeps only
  conveniences in localStorage (last workspace, sidebar collapsed).
- Passwords are hashed with PBKDF2-SHA256 (100k iterations, the Workers
  maximum) and a per-user salt.
- Sign-in sets an `httpOnly` cookie holding a random token; only its SHA-256
  is stored (`sessions`). Sessions last 30 days.
  - Changing your password signs out your other sessions.
  - An admin or operator setting someone's password, or deactivating them,
    signs that person out everywhere.
- The browser calls one endpoint, `POST /api/rpc/<method>` (JSON only).
  Every method checks the session and the caller's role on the server.
- A workspace Administrator can change someone's name, email or password only
  if that person belongs to that workspace alone. For everyone else (people
  in several workspaces, operators), only the platform operator can.

## What's in it

- **Platform operator** (`/platform`):
  - **Accounts** (Active / Inactive tabs): create, rename, upload a **logo**
    (PNG, JPG, WebP or SVG up to 512 KB, shown in that workspace's sidebar
    instead of the default mark), activate or deactivate, open the
    workspace, and manage members (attach a user with a role, change role,
    remove).
  - **Users**: create a user (optionally as an operator), edit, deactivate
    platform-wide, set a password, and attach to workspaces with a role per
    workspace.
  - Operators can enter any workspace and act as its Administrator; a banner
    shows this.
- **Workspaces** (`/w/<accountId>/…`):
  - One user can belong to several workspaces, with a **role per workspace**.
  - The sidebar switcher changes workspace. `/workspaces` is the picker; on
    sign-in it opens your only workspace or your last-used one automatically.
- **Roles inside a workspace**:
  - **Administrators** create, edit and delete tasks and meetings.
  - **Members** see only tasks assigned to them and meetings they attend or
    organize. On their own tasks they can change the status (not to
    Cancelled); everything else is read-only.
- **Tasks**: `T-n` numbers per workspace; status, priority, dates with
  optional time, assignees (workspace members), and **Related to** a meeting.
  List view with a side panel, inline status (and priority for admins),
  search and pagination. Members: Assigned to me / Completed. Administrators:
  All / Completed with filters (status, priority, assignee, due). "Related
  to" is offered on the task page only (default: nothing); tasks created
  from a meeting are linked to it automatically.
- **Calendar**: Month and Week views (an agenda list on phones), meetings with
  attendees, task due dates, and meetings → **Action items** (tasks related to
  the meeting; members see only theirs).
- **Members** (Administrators, `/w/<accountId>/members`):
  - See each member's name, email and role.
  - Add someone by **email and role**. An existing sign-in just joins; a new
    email gets an account with a one-time temporary password to share (they
    can change it in Settings).
  - Change a member's role, or **revoke** their access to the workspace.
    Names, emails and passwords are managed by each person (Settings) or the
    platform operator.
- **Settings**: change your name and language, and change your own password.

## Notifications and reminders

- **In-app** (sidebar bell) and **Web Push** (free, via the PWA), per person
  and per type in Settings → Notifications. Push sends an empty ping; the
  service worker fetches the text over the signed-in API.
- **Due date reminders**: a Cron Trigger (`0 * * * *`, see `wrangler.jsonc`)
  runs `server/services/reminders.ts` hourly. Each person gets reminders at
  08:00 in their own time zone (reported by their browser; UTC until then) for
  open tasks due today, due tomorrow, and once when a task becomes overdue.
  `task_reminders` logs what was sent so nothing repeats.
- The Worker entry is `custom-worker.ts`: OpenNext's app for HTTP plus the
  `scheduled` handler. Test locally with
  `wrangler dev --test-scheduled` and `curl "localhost:8787/__scheduled?cron=0+*+*+*+*"`.
- Push keys: `VAPID_PUBLIC_KEY` (in `wrangler.jsonc`) and the
  `VAPID_PRIVATE_KEY` secret (`wrangler secret put`, and `.dev.vars` locally).

## Google Calendar and Google Tasks (two-way sync)

Design: `docs/plan-google-sync.md`. Each person connects their own Google
account in Settings.

- **Workspace items.**
  - Tasks assigned to them and meetings they organise or attend are copied into
    a "Taskly · <Workspace>" task list and calendar in their Google account.
  - Edits go both ways, with the same rules as the app: members can only tick
    tasks done in Google; their other edits are undone, with a notice.
  - New items an administrator adds to those lists/calendars become workspace
    tasks or meetings.
- **Personal items.** Their own Google Tasks and calendars show in Taskly, read
  and written live and private to them: the Personal tab on Tasks, the "Google
  events" switch on the Calendar, and the dashboard.
- **How it runs.**
  - Writes queue jobs in `google_sync_jobs`; the jobs run right after the
    response, and every 5 minutes from the second Cron Trigger
    (`server/google/cron.ts`).
  - Google Tasks is polled, because it has no push.
  - Calendars use push notifications to `/api/google/webhook` when `APP_ORIGIN`
    is a public https URL; otherwise they are polled.
  - "Sync now" in Settings, and opening the app, pull right away.

Setup:

1. In Google Cloud: enable the Calendar API and the Tasks API, configure the
   OAuth consent screen, and create an OAuth client of type **Web
   application**. Its redirect URIs are `http://localhost:3100/api/google/callback`
   and `https://<your domain>/api/google/callback`.
2. Copy `.dev.vars.example` to `.dev.vars` and fill in `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET` and `GOOGLE_TOKEN_KEY` (32 random bytes, base64). In
   production use `wrangler secret put` for each, and set `APP_ORIGIN` in
   `wrangler.jsonc`.
3. Run `yarn db:migrate:local` (or `:remote`) for `migrations/0007_google_sync.sql`.
4. While the consent screen is in *Testing*, only listed test users can connect,
   and Google expires their access after 7 days. Publish the app (Google reviews
   the Calendar/Tasks scopes) before real users connect.

Without a Google project, `node scripts/google-mock.mjs` runs a local stand-in
for Google (OAuth, Tasks, Calendar). Point `GOOGLE_API_ORIGIN` and
`GOOGLE_OAUTH_ORIGIN` at it, with any client id and secret. Unit tests for the
mapping and merge logic: `yarn test`.

## Structure

- `server/`: the backend.
  - `api.ts`: every method the browser may call.
  - `context.ts`: sessions, `requireWorkspace`, `requireOperator`.
  - `services/*`: auth, tasks, meetings, members (workspace-scoped), platform
    (operator-only). Each validates its input (`validate.ts`) and runs SQL.
  - `crypto.ts`: password hashing and session tokens. `db.ts`: D1 helpers and
    row mapping.
  - `google/*`: Google sync.
    - `oauth.ts` and `client.ts`: sign-in and token handling.
    - `mapping.ts` and `merge.ts`: pure logic, with unit tests.
    - `queue.ts`: the outbox.
    - `sync-tasks.ts`, `sync-meetings.ts` and `pull.ts`: the two directions.
    - `personal.ts`: the person's own Google items.
    - Route handlers live in `app/api/google/*`.
- `app/api/rpc/[method]/route.ts`: the HTTP endpoint.
- `lib/api/*`: the browser side, with typed functions that call the server.
- `lib/permissions.ts`: who may see or change what, shared by server and UI.
- `migrations/`: the database schema. `lib/seed.ts` + `scripts/seed.mjs`:
  sample data.
- `features/workspace/workspace-context.tsx`: the current workspace, the role
  in it, and `useWorkspacePath()`.
- `features/{tasks,calendar,users,platform,auth}`: the feature UI.
- `components/ui/*`: base-ui primitives adapted from the Corpus frontend.
  `components/shell/*`: app chrome (Pretace-style sidebar).
