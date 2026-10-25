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

Local development needs no Cloudflare account: the database is a local SQLite
file under `.wrangler/`. The one binding that can't run locally is Workers AI
(the Cloudflare translation options and the Workers AI meeting summaries). To
use it under `yarn dev`, run `yarn wrangler login` and put
`TASKLY_DEV_REMOTE_AI=1` in `.env.local`. Without it those options fail with
"needs to be run remotely" and nothing else changes.

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

A new deployment (another Cloudflare account): follow
[docs/deploy.md](docs/deploy.md). Updating an existing one:

```bash
yarn db:migrate:remote  # apply new files in migrations/ to the live database
yarn deploy             # build and upload the Worker
```

On cPanel hosting (a Node.js app with a SQLite database) instead:
`yarn build:cpanel`, then follow [docs/cpanel.md](docs/cpanel.md).

Schema changes go in a new numbered file in `migrations/`; never edit one
that has already been applied. Run `yarn cf-typegen` after changing
`wrangler.jsonc`.

**Per-deployment configuration.** The same build serves every deployment. Each
one needs its own `name` and D1 database in `wrangler.jsonc`, and one secret:

```bash
wrangler secret put ENCRYPTION_KEY   # 32 random bytes, base64; set once, never change
```

Everything else is set by an operator in **Platform → Settings**, with no
redeploy: the app's address, email (the cPanel mailbox), the Google OAuth client,
and push keys (generated there). Secrets are stored encrypted with
`ENCRYPTION_KEY`. Values in the environment (`.dev.vars`, secrets) are a fallback
for any group not saved in the console.

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
  - **Administrators** create, edit and delete workspace tasks (assigned to
    anyone) and meetings.
  - **Members** see only workspace tasks assigned to them and meetings they
    attend or organize. On those tasks they can change the status (not to
    Cancelled); everything else is read-only. Members can't assign tasks.
  - **Private tasks**: anyone can create tasks for themselves. Only their
    creator sees them (not even other administrators or operators), and the
    creator can edit, cancel and delete them. They can't be assigned to others.
- **Tasks**: status, priority, dates with
  optional time, assignees (workspace members), and **Related to** a meeting.
  List view with a side panel, inline status (and priority for admins),
  search and pagination. Tabs: **Mine** (your private tasks, plus your own
  Google Tasks when Google is connected), **Assigned to me**, **All**
  (administrators only, with filters for status, priority, assignee and due)
  and **Completed**. "Related
  to" is offered on the task page only (default: nothing); tasks created
  from a meeting are linked to it automatically.
- **Arabic ↔ English translation**: a meeting's title and agenda written in
  one language are saved in the other too, after the save (it never waits),
  with retries every 5 minutes. The meeting panel shows the translation under
  the original, marked "Machine translated"; administrators can **Translate
  again**. Only changed fields are re-translated (edits from Google Calendar
  too). Operators pick the service in **Platform → Settings → Translation**:
  Microsoft Azure Translator, Google Cloud Translation, DeepL, Amazon
  Translate, Cloudflare Workers AI (an AI model, or m2m100; no key, uses the
  deployment's `AI` binding) or Anthropic Claude (default `claude-haiku-5-5`),
  with **Test translation**. Code: `server/translate/`. Locally,
  `node scripts/translate-mock.mjs` stands in for the paid services
  (`TRANSLATE_API_ORIGIN` in `.dev.vars`).
- **Calendar**: Month and Week views (an agenda list on phones), meetings with
  attendees, task due dates, and meetings → **Action items** (tasks related to
  the meeting; members see only theirs).
- **Members** (Administrators, `/w/<accountId>/members`):
  - See each member's name, email and role.
  - Add someone by **email and role**:
    - **A new email** gets an account at once and an **invitation email** with
      a one-time link to choose a password (valid 7 days; **Resend invitation**
      on the members page until they do). Without email set up, or if sending
      fails, the administrator gets a one-time temporary password instead.
    - **Someone who already has an account** is *invited*: they get an email
      and a notification, and join only when they **Accept** on the workspaces
      page (or **Decline**). The administrator sees them under **Waiting to
      accept** (Resend, Cancel invitation) and is notified of the answer.
  - Operators creating users in Platform → Users can **email an invitation**
    instead of setting a password (the default when email is set up). Attaching
    a user to a workspace from the console is immediate.
  - Change a member's role, or **revoke** their access to the workspace.
    Names, emails and passwords are managed by each person (Settings) or the
    platform operator.
- **Settings**: change your name and language, and change your own password.
- **Several email addresses, one login** (Settings → Email addresses): for
  people whose workspaces each know them by a different address. Extra
  addresses are confirmed by an emailed link (24 hours) and then:
  - sign in (same password, no switching accounts);
  - match invitations, so an admin inviting `omar@client.com` reaches Omar's
    existing account instead of creating a second one;
  - can be chosen per workspace: that workspace sees only that address on its
    members list, and its notification emails go there.
  Unconfirmed addresses match nothing. Up to 5 extra addresses; any confirmed
  one can become the primary. Operators find people by any of their addresses.
- **Sign-in protection**: after 5 failed sign-ins for one email in 15
  minutes, that email is blocked for 15 minutes (even with the right password;
  **Forgot password?** still works); one network address is capped at 30
  failures. Pages and files are sent with security headers (no framing,
  `nosniff`, HSTS) from `next.config.ts` and `public/_headers`.
- **Forgot password?** (on the sign-in page, needs email set up): emails a
  one-time link valid for 1 hour (at most one email a minute). The answer is
  the same whether or not the address has an account. Choosing a new password
  signs the person out of every other session.
- **Live meetings (beta)**: a desktop engine on the meeting laptops (Windows, macOS or Linux) turns the meeting's audio into Arabic↔English lines and pushes them to Taskly, optionally handing the speech work to a GPU PC (the model server); a finished session's review draft becomes minutes and action-item tasks once accepted. See [desktop-engine/README.md](desktop-engine/README.md) and [docs/live-meetings.md](docs/live-meetings.md).

## Notifications and reminders

- **In-app** (sidebar bell), **Web Push** (free, via the PWA) and **Email**,
  per person and per type in Settings → Notifications. Email is off until the
  person turns it on. Push sends an empty ping; the service worker fetches the
  text over the signed-in API.
- **Due date reminders**: a Cron Trigger (`0 * * * *`, see `wrangler.jsonc`)
  runs `server/services/reminders.ts` hourly. Each person gets reminders at
  08:00 in their own time zone (reported by their browser; UTC until then) for
  open tasks due today, due tomorrow, and once when a task becomes overdue.
  `task_reminders` logs what was sent so nothing repeats.
- The Worker entry is `custom-worker.ts`: OpenNext's app for HTTP plus the
  `scheduled` handler. Test locally with
  `wrangler dev --test-scheduled` and `curl "localhost:8787/__scheduled?cron=0+*+*+*+*"`.
- Push keys: **Generate new keys** in Platform → Settings (or
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in `.dev.vars`). New keys drop every
  device's subscription; people turn push on again.
- **Email** (`server/mail/`): invitations, password resets and email
  notifications go out over SMTP through the cPanel mailbox, set in
  Platform → Settings (mail server, port 465 with TLS, mailbox and password,
  From), with **Send test email**. A small SMTP client on `node:tls` runs in
  both `next dev` and Workers; Workers can't use port 25, and the app won't
  send a password to a remote server without TLS. Locally,
  `node scripts/smtp-mock.mjs` catches mail (viewer on http://localhost:2526);
  `.dev.vars` points at it by default.

## Google Calendar and Google Tasks (two-way sync)

Design: `docs/plan-google-sync.md`. Each person connects their own Google
account in Settings.

- **Workspace items.**
  - Tasks assigned to them and meetings they organise or attend are copied into
    a "Taskly · <Workspace>" task list and calendar in their Google account.
  - Edits go both ways, with the same rules as the app: members can only tick
    tasks done in Google; their other edits are undone, with a notice.
  - A task anyone adds to their "Taskly · <Workspace>" list becomes their own
    private task. An event an administrator adds there becomes a meeting.
  - Private tasks go to Google only if their **Sync to Google Tasks** switch
    is on.
- **Personal items.** Their own Google Tasks and calendars show in Taskly, read
  and written live and private to them: under **Mine** on Tasks, the "Google
  events" switch on the Calendar, and the dashboard.
- **How it runs.**
  - Writes queue jobs in `google_sync_jobs`; the jobs run right after the
    response, and every 5 minutes from the second Cron Trigger
    (`server/google/cron.ts`).
  - Google Tasks is polled, because it has no push.
  - Calendars use push notifications to `/api/google/webhook` when the app
    address (Platform → Settings) is a public https URL; otherwise they are polled.
  - "Sync now" in Settings, and opening the app, pull right away. "Sync now"
    also retries that person's jobs that had stopped retrying.
- **Time zone.** Meeting times are in the workspace's zone, set by an operator
  in Platform → Accounts (otherwise each organiser's own). Changing it rewrites
  the times on every Google copy.
- **When sync fails.** A job retries after 1, 5 and 30 minutes and 2 hours,
  then stops. Operators then get a notification (at most one an hour), and
  Platform → Google sync lists failing work and people who must reconnect,
  with a **Retry failed** button.

Setup:

1. In Google Cloud: enable the Calendar API and the Tasks API, configure the
   OAuth consent screen, and create an OAuth client of type **Web
   application**. Its redirect URIs are `http://localhost:3100/api/google/callback`
   and `https://<your domain>/api/google/callback`.
2. In Platform → Settings, set the app address, then enter the Client ID and
   Client secret under **Google sign-in** (it shows the redirect URI to add).
   Locally you can use `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in
   `.dev.vars` instead. `ENCRYPTION_KEY` must be set (it encrypts the tokens).
3. Run `yarn db:migrate:local` (or `:remote`) for the migrations.
4. While the consent screen is in *Testing*, only listed test users can connect,
   and Google expires their access after 7 days. Publish the app (Google reviews
   the Calendar/Tasks scopes) before real users connect.

Without a Google project, `node scripts/google-mock.mjs` runs a local stand-in
for Google (OAuth, Tasks, Calendar). Point `GOOGLE_API_ORIGIN` and
`GOOGLE_OAUTH_ORIGIN` at it, with any client id and secret. Unit tests for the
mapping, merge and permission rules: `yarn test`.

## Claude connector (MCP)

Plan: `docs/plan-claude-connector.md`. People connect Taskly to Claude (claude.ai,
Claude Desktop, mobile and Cowork) as a custom connector. They paste
`<App address>/mcp` into Claude, sign in to Taskly, and click Allow.
Settings → **Set up MCP** walks them through it and lists their connections,
each with Disconnect.

- **Phase 1 (built):** read-only tools.
  - `list_workspaces`, `list_people`, `find_tasks`, `get_task`,
    `find_meetings`, `get_meeting` and `get_minutes`.
  - They run as the signed-in person with the app's own permission checks.
    Operator powers don't apply: the connector acts only where they're a member.
  - People with several workspaces pick one per conversation; the server
    refuses calls without one.
- **Phase 2 (built): write actions in plain language, no commands.**
  - `create_my_task` adds a private task for yourself.
  - `set_task_status` completes or reopens a task.
  - `save_minutes` saves minutes; replacing existing ones needs `replace: true`.
  - Administrators can also give tasks to others with `review_task_delegation`
    → `delegate_task`, and schedule meetings with `review_meeting` →
    `create_meeting`.
  - The create step only accepts a single-use, 15-minute draft from the review
    (`mcp_drafts`, migration `0018`), so the person always sees the review
    first.
  - Names are matched forgivingly ("Umar", "عمر" → Omar) but never guessed;
    meeting reviews flag clashes.
  - Writing needs the `taskly.write` scope.
  - People who are an administrator nowhere don't see the delegation and
    meeting tools.
- **Phase 3 (built): interactive cards in the Claude apps** (MCP Apps).
  - `my_day` shows today's meetings and due tasks, which can be ticked done.
  - `choose_meeting` and `choose_people` are pickers; people have photos and
    there is a search.
  - The two reviews show a card with Create and Discard. When a name fits
    several people, the card asks who was meant.
  - A choice made on a card arrives in the chat as the person's next message.
  - Cards follow Claude's light or dark theme and the person's language
    (Arabic right to left).
  - Voice, Claude Code and apps without cards get the same answers in words.
  - The card is one page built from `server/mcp/cards/view` by `yarn cards`.
    `dev`, `build`, `build:cpanel` and `typecheck` run it first; the output,
    `card-html.generated.ts`, isn't committed.
  - Photos use hour-long photo links (`mcp_photo_links`, migration `0019`)
    that end when Claude is disconnected.
- **Endpoint:** `/mcp` is a stateless Streamable HTTP endpoint (MCP TypeScript
  SDK v2, JSON responses only). It serves both the 2026-07-28 and 2025-era
  protocols, on Cloudflare and on Node.
- **Sign-in:** Taskly is its own OAuth 2.1 server.
  - Endpoints: `/oauth/authorize` (the consent page), `/oauth/token`,
    `/oauth/register` (DCR) and `/oauth/revoke`, plus the discovery documents
    under `/.well-known/`.
  - Claude identifies itself with a Client ID Metadata Document, which Taskly
    fetches.
  - Redirects are limited to `https://claude.ai/api/mcp/auth_callback` and
    loopback addresses (Claude Code).
  - Tokens are stored hashed. Access tokens last an hour. Refresh tokens last
    60 days and rotate; reusing one ends the connection. Deactivating or
    deleting a user ends their connections.
- **Setup:** set the App address (Platform → Settings) to the public https
  URL and run migrations `0017`, `0018` and `0019`. Nothing else is needed: no keys, no Anthropic
  account. A localhost App address works with Claude Code only.
- **Claude logo:** save Anthropic's official Claude logo as
  `public/brand/claude.svg`, following their brand guidelines. Until then a
  neutral mark is shown.
- **Try it locally with Claude Code:** run
  `claude mcp add --transport http taskly http://localhost:3100/mcp`, then
  `/mcp` → Authenticate.

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
  - `mcp/*`: the Claude connector.
    - `oauth-rules.ts`: pure rules, with unit tests.
    - `clients.ts`: CIMD and DCR clients.
    - `grants.ts`: codes, connections and tokens.
    - `authorize.ts`: checks authorization requests.
    - `endpoints.ts`: the HTTP endpoints.
    - `server.ts`: the MCP server.
    - `tools.ts` (read) and `actions.ts` (write): the tools.
    - `match.ts`: name matching, with tests.
    - `drafts.ts`: review drafts.
    - `photos.ts`: photo links for cards.
    - `cards/`: the interactive card.
      - `resource.ts`: the card page.
      - `tools.ts`: `my_day` and the pickers.
      - `types.ts`: what cards read.
      - `view/`: the card itself, built by `scripts/build-cards.mjs`.
    - `workspaces.ts`: choosing a workspace.
    - Routes live in `app/mcp`, `app/oauth/*` and `app/.well-known/*`.
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
