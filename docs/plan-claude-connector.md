# Plan: Taskly as a Claude connector (remote MCP server)

Status: **phases 1, 2 and 3 built** (2026-10-13). Decisions are recorded in §13.

**Phase 3 as built (interactive cards, MCP Apps):**

- **One card page** (`server/mcp/cards/view`), built by `yarn cards`
  (`scripts/build-cards.mjs`, run automatically by `dev`, `build`,
  `build:cpanel` and `typecheck`) into one self-contained HTML page of about
  460 KB.
  - It uses `@modelcontextprotocol/ext-apps` 2.0.3 and is served as
    `ui://taskly/card-<hash>.html`. Older versions' addresses get the current
    page.
  - It follows Claude's light and dark theme, colours and font, has no border
    of its own, and is in Arabic (right to left) or English, following the
    person's Taskly language.
- **New tools that show a card:**
  - `my_day`: today's meetings, plus tasks due today or overdue, which can be
    ticked done or unticked.
  - `choose_meeting`: a meeting picker, most recent first.
  - `choose_people`: a people picker with photos and search.
- **Review cards:** `review_task_delegation` and `review_meeting` show a card
  with **Create** and **Discard**.
  - Create uses the same single-use draft as confirming in words.
  - Clashes are highlighted on the person's chip and listed.
  - A name that fits several people is now a question rather than an error
    (`status: "needs_choice"`, nothing drafted). The card lists the
    candidates and reviews again with the person's choice.
  - Editing happens in the chat ("To change something, just tell Claude"), as
    Claude's design guidelines recommend.
- **Talking back to Claude:**
  - A choice on a picker becomes the person's next message, with the ids passed
    alongside (`ui/update-model-context`).
  - Create, Discard and ticks are reported the same way, so Claude never
    creates something twice.
- **Photos:** a card has no Taskly cookie, so results carry short-lived photo
  links (migration `0019_mcp_photo_links.sql`).
  - Each link is one random token per result. It shows photos only, to the
    same people the person could see them in Taskly.
  - It lasts an hour and stops when Claude is disconnected.
  - Tokens never appear in the text Claude reads.
- **Errors carry a code** (`structuredContent.error`), so cards explain them in
  the person's language.
- **Text still works everywhere:** every card tool answers in words too, so
  voice, Claude Code and apps without cards behave as in phase 2.
- **Set up MCP:** starts with "What's on today in Taskly?" and mentions the
  cards.
- **Testing:**
  - Unit tests cover the card helpers.
  - The phase 3 end-to-end run passed 38 of 38 checks.
  - The phase 1 run (now 51 checks) and phase 2 run (35) still pass.
  - The cards were rendered and clicked in a local host built on the SDK's
    `AppBridge`, in English and Arabic, light and dark, and at 360 px.
  - The built Worker served the card on workerd over both protocol versions.
  - The real Claude apps need the public https deployment.

**Phase 2 as built (write actions in plain language):**

- **Tools:**
  - `create_my_task`, `set_task_status` (not cancelled: that stays in the app),
    and `save_minutes` (with `replace`).
  - For administrators: `review_task_delegation` → `delegate_task` and
    `review_meeting` → `create_meeting`.
  - Reviews return a `spokenSummary` and a single-use 15-minute draft
    (migration `0018_mcp_drafts.sql`).
- **Name matching:** whole names and first names count as clear. Partial words
  and sound-alikes ("Umar", Arabic script) count as "understood as …" and
  appear in the review. Two possible people means Claude asks.
- **Instructions:** the server instructions describe the four actions; there
  are no MCP prompts.
- **Reconnecting:** reconnecting a DCR app with the same name and host replaces
  its earlier connection.
- **Testing:**
  - Unit tests cover name matching.
  - A phase 2 end-to-end run passed 35 of 35 checks, and phase 1's 50 checks
    still pass.
Distribution is as a **custom connector only**; there is no Connectors
Directory listing. The official connector URL is on the **Cloudflare**
deployment: `<App address>/mcp`, where the App address is set in Platform →
Settings.

**Phase 1 as built:**

- **What it includes:**
  - The OAuth server: discovery, CIMD and DCR clients, the consent page,
    token, refresh and revoke.
  - `/mcp` with the seven read tools from §6.
  - Login `?next=`.
  - Settings → Set up MCP and the dashboard card.
  - Revoking connections on deactivation and deletion.
  - Migration `0017_claude_connector.sql`.
- **Where it differs from the plan:**
  - `find_tasks` pages with `page`/`limit` rather than a cursor.
  - The starter prompts in Set up MCP were read-only questions; phase 2
    swaps them for the four actions.
  - There is no Platform on/off switch yet. The connector is available
    whenever the App address is https (or localhost, for Claude Code). The
    switch, a DCR rate limit and cleanup of unused registrations move to
    phase 4.
- **Testing:**
  - `yarn test` covers the OAuth rules.
  - An end-to-end run against `yarn dev` passed 50 of 50 checks. It covered
    discovery, the 401 challenge, DCR, consent, code exchange and PKCE, all
    tools over the 2025 and 2026-07-28 protocols, member versus admin
    visibility, private tasks, refresh rotation and reuse detection, error
    redirects, a real fetch of Claude Code's CIMD from claude.ai, Disconnect,
    and revoke.

## 1. Goal

People connect their Taskly account to **Claude** (claude.ai on the web, Claude
Desktop, Claude mobile, and Cowork) and then simply **say what they want**, by
typing or by voice. There are no commands to learn. Claude picks the right
Taskly tool from what the person says.

| What people say (examples) | Who | What happens |
| --- | --- | --- |
| "Remind me to renew the trade licence on Thursday" | everyone | A private task for yourself |
| "Here are my notes from today's standup: write the minutes" | everyone | Minutes of a meeting you pick, saved in Taskly |
| "Give Omar the venue booking, due Friday" | administrators | A task assigned to the people you name, after a review |
| "Set up a budget review with Sara next Tuesday at 3" | administrators (Claude declines for members) | A meeting: Claude asks about anything missing and shows a review first |

*Decided (§13.7):* no slash commands. They aren't documented for the Claude
apps and people don't remember them. Plain language works everywhere,
including voice.

The same server also works from Claude Code
(`claude mcp add --transport http taskly https://<host>/mcp`) and from the
Claude API's MCP connector, so nothing about it is specific to one client.

## 2. Options considered

| Option | Works in Claude apps (web, desktop, mobile)? | Verdict |
| --- | --- | --- |
| **Remote MCP server inside Taskly, with OAuth** (one URL per deployment) | Yes, as a custom connector, and later through the Connectors Directory | **Recommended** |
| Remote MCP server with personal API tokens instead of OAuth | Only as an org-owner "static header", which is beta and shared by the whole org, so it isn't per person. Fine for Claude Code. | Possible later add-on for Claude Code and scripts |
| Local MCP server (an npm package run on the user's computer) | Desktop only, never web or mobile; the Directory no longer accepts local MCPB listings | No |
| Skill or prompt only, with no server | Claude can't reach Taskly's data | No |

## 3. Facts that shape the design (sources in §14)

- **Claude connector requirements:**
  - A public HTTPS URL using Streamable HTTP.
  - Sign-in starts only when the server answers HTTP **401** with `WWW-Authenticate: Bearer resource_metadata="…"`.
  - OAuth with PKCE S256.
  - Client identity via **CIMD**, which Claude recommends. Claude only uses it if the server advertises `client_id_metadata_document_supported: true` and accepts `"none"` as the token endpoint auth method. Otherwise it falls back to **DCR** and registers a new client on every connection.
  - Redirect URI `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a loopback redirect on a random port.
  - Token endpoint responses within 10 s (30 s for refresh), and refresh tokens rotated.
  - Tool results under about 150,000 characters and 240 s.
  - Every tool should carry a `title` plus `readOnlyHint` and `destructiveHint`. Claude runs read-only tools without asking and asks before other tools, unless the user chose "Always allow".
- **MCP spec:**
  - The current revision, 2026-07-28, is stateless: no sessions, no `initialize`. DCR is deprecated in favour of CIMD.
  - Servers must validate `Origin`, check the token's audience (RFC 8707 `resource`), and publish Protected Resource Metadata (RFC 9728).
  - Elicitation is replaced by `InputRequiredResult`, which Claude is not documented to support. So asking questions stays Claude's job in the chat.
- **TypeScript SDK v2** (`@modelcontextprotocol/server` 2.3.x with zod ≥ 4.2):
  - `createMcpHandler(factory, { responseMode: "json" })` returns a Web `fetch` handler. It runs unchanged in a Next.js route handler on both Cloudflare (OpenNext) and cPanel (Node).
  - The default `legacy: "stateless"` mode also serves clients still on the 2025-11-25 revision.
  - It has resource-server helpers (`requireBearerAuth`, PRM responses, `scopeChallenge`). Its authorization-server helpers are Express-only and deprecated, so Taskly needs its own small authorization server.
- **Cloudflare's `workers-oauth-provider`** needs KV and runs on Workers only. Using it would mean a second auth system for cPanel, so we won't.
- **Interactive UI in chat ("MCP Apps")** is stable: `@modelcontextprotocol/ext-apps` 2.x. It renders in the Claude apps but not in Claude Code. Hosts that don't support it fall back to the plain text result automatically.
- **Taskly constraints:**
  - Two runtimes (Cloudflare D1 and cPanel SQLite), and no streaming anywhere today.
  - No bearer-token auth exists; the session cookie is the only way to sign in.
  - The login page has no "return to" parameter.
  - The global CSP `form-action 'self'` would block a consent form that POSTs and is then redirected to claude.ai.
  - Members can create only **private** tasks. Shared tasks and meetings are for administrators.
  - Minutes are one set per person per meeting, private, shared with the workspace, or shared with chosen people.

## 4. How people ask: plain language, no commands

- **Tools** (§6) do the work. Each tool's description says when to use it, and
  the server's instructions describe the four workflows. So "add a task…",
  "remind me to…", "write the minutes…", "give Omar…" and "schedule a meeting
  with…" all lead Claude to the right steps, in any client and in voice.
- **Choosing things:** Claude calls a read tool that returns the candidates
  (meetings you can see, workspace members), then asks you to pick in the chat.
  In phase 3, interactive cards show a real picker and a review card inside the
  Claude apps instead (§11).
- **Team conventions without code:** a Claude **Project** named "Taskly", with
  the connector turned on and short instructions (for example the team's
  minutes template, or "write minutes in English and Arabic"), applies those
  rules to everyone who chats in it.

## 5. The four actions

### 5.1 A task for yourself

1. You give the title, and optionally a due date and time, a priority and notes.
   Claude asks only if there is no title.
2. Claude interprets relative dates ("Friday", "tomorrow 3pm") using the
   workspace date and time zone from `list_workspaces`.
3. `create_my_task` creates a **private** task: only you see it, and you are its
   only assignee.
   - This is the only kind of task members can create today, so it behaves the
     same for everyone.
   - If you have Google connected, the task can also go to your Google Tasks
     (`googleSync`, which already exists for private tasks).
4. Claude replies with the task and a link to open it in Taskly.

One step, no review: the task only affects you. Claude's own "allow this
action?" prompt still appears unless you chose Always allow.

*Decided (§13.1):* this always creates a **private** task, for
administrators too. Tasks for other people go through §5.3.

### 5.2 Minutes of a meeting

1. **Pick the meeting.**
   - `find_meetings` lists meetings you can see: the past 14 days by default,
     searchable by title or date. Each result says whether you already have
     minutes for it.
   - Claude asks which one. If the request names one ("today's standup") and
     only one matches, Claude confirms it in a sentence.
2. **Gather the material.**
   - `get_meeting` provides the title, date, time, attendees, agenda notes and
     existing action items.
   - You paste or upload the notes or transcript, or dictate the points.
3. **Draft.**
   - Claude writes the minutes in a fixed template: summary, attendees,
     decisions, action items (who, what, by when), and next steps.
   - It writes in your language. Readers can already translate minutes in
     Taskly.
4. **Review.** Claude shows the draft and asks who can read it: only you, the
   whole workspace, or chosen people (normally the attendees).
5. **Save.** `save_minutes` creates your minutes for that meeting. If you
   already have minutes there, it refuses unless Claude passes `replace: true`,
   so Claude asks you first. The replace uses the version it read, so an edit
   made in Taskly in the meantime is never overwritten silently.
6. **Optional: action items become tasks.**
   - Administrators can turn each action item into a task linked to the meeting,
     through §5.3 (with its review).
   - Members can turn their own action items into private tasks.

### 5.3 A task for other people (administrators)

1. You describe the task and who should do it.
2. **Pick the assignees.** `list_people` returns the workspace members. Names in
   the request are matched server-side. When a name is ambiguous or unknown,
   the review lists the candidates and Claude asks you to choose.
3. **Review.**
   - `review_task_delegation` checks everything without saving: active members
     only, a valid date, a related meeting you can see.
   - It returns a short summary and a draft handle that lasts 15 minutes.
   - Claude shows the summary.
4. **Create.** After you confirm, `delegate_task` creates the shared task from the
   draft. Taskly's usual notifications, emails and Google sync follow, as if
   you had done it in the app.

### 5.4 A new meeting, with clarifying questions and a review (administrators)

1. **Clarify.** Claude needs a title, a date, a start time, an end time or
   duration, and attendees. Location or link and agenda are optional. It asks
   for whatever is missing, a few questions at a time.
2. **Review.**
   - `review_meeting` checks the request:
     - end after start;
     - times interpreted in the workspace time zone;
     - attendees are active members (names matched as in §5.3);
     - **clashes** with the attendees' other Taskly meetings.
   - It returns a summary, any warnings, and a draft handle.
   - Claude shows the review and asks you to confirm or change it.
3. **Create.** `create_meeting` creates the meeting from the draft. Invitations,
   Google Calendar copies and translations follow automatically.

**Members asking for a meeting:** Claude declines (*decided, §13.2*). Members
don't see the meeting tools at all, and the server instructions tell Claude to
say that only workspace administrators can schedule meetings, and to suggest
asking one. Nothing is created.

**Why reviews are enforced by the server, not just asked for:** the write tools
only accept a draft handle that the review step issued, for the same person,
within 15 minutes. Claude therefore can't skip the review even if a prompt
tells it to. This follows the spec's "server-minted handle" pattern, with
handles bound to the user.

### 5.5 Choosing the workspace (a "session" per conversation)

*Decided (§13.3):*

- **One workspace:** used automatically. Claude never asks.
- **Several workspaces:**
  - Every conversation starts with picking one. On the first Taskly request in
    a chat, Claude calls `list_workspaces` and asks: "Which workspace: Acme
    Consulting or Northwind Trading?" It skips the question if the request
    already names one ("in Northwind, add a task…").
  - Claude then passes that `workspace` on every call for the rest of the
    conversation.
  - "Switch to Northwind" changes it mid-conversation.
  - A new conversation asks again. Nothing is remembered between chats, so a
    task never lands in the wrong workspace because of yesterday's choice.
- **Enforced by the server, not just asked for:** for people with several
  workspaces, a call without `workspace` returns the tool error
  `workspace_required` with the list of workspaces, so Claude has to ask. The
  connection itself is not tied to a workspace, and the consent screen has no
  workspace picker.
- **What Claude learns when the workspace is chosen:** `list_workspaces`
  returns, for each workspace, your role, today's date and its time zone.
  Claude therefore knows straight away which actions apply: members can't give
  tasks to others or schedule meetings.

### 5.6 Voice and dictation

**How each input mode behaves:**
- **Dictation**, the microphone in the message box: speech becomes ordinary
  text before it reaches Claude. To the connector it is the same as typing.
- **Voice mode**, a spoken conversation:
  - It can use the tools you have connected, and Anthropic says connected tools
    behave the same as in text chat. Their examples are Google and Slack. Custom
    connectors in voice mode aren't mentioned explicitly, so **test it**.
  - Interactive UI (phase 3) will probably not show in voice. The conversational
    flow above is what voice uses.
  - Voice mode isn't available in Claude Code or Cowork; dictation is.

**Language gap:** Claude's own mobile dictation doesn't list Arabic. Its
languages are English, French, German, Hindi, Italian, Japanese, Korean,
Portuguese, Russian, Spanish, Turkish and Ukrainian, with non-English in beta.
Arabic speakers can use their phone keyboard's dictation instead; the text
arrives in Claude the same way. Voice mode supports more languages than
dictation.

**What the server does to work well with speech:**

1. **Plain phrases.** There is no syntax to say. The tool descriptions and
   server instructions recognise:
   - "add a task", "remind me to …" → a task for yourself
   - "take minutes", "minutes for …", "MoM" → minutes
   - "give Omar a task to …", "assign … to …" → a task for others
   - "schedule a meeting with …", "set up a call …" → a meeting
2. **Forgiving name matching.** Transcription mangles names: "Umar" for Omar,
   "Sarah" for Sara, Arabic script for a Latin-spelled name. Matching ignores
   case and accents, tolerates small spelling differences, and maps Arabic to
   Latin names.
   - The match never picks silently: anything below an exact match is listed
     in the review for you to confirm.
3. **Spoken dates.** Claude resolves phrases like "next Thursday at half past
   three" or "in two weeks" using the date and time zone from
   `list_workspaces`.
   - Every review repeats the **absolute** date and time, for example
     "Thursday 22 October, 15:30–16:00", so a misheard date is caught before
     anything is created.
4. **Reviews you can say aloud.**
   - `review_meeting` and `review_task_delegation` return a one-sentence
     `spoken_summary` next to the structured data. For example: "Create 'Budget
     review' on Thursday 22 October, 3:30 to 4 pm, with Omar and Sara. Omar
     has 'Client call' at 3:45. Create it?"
   - "Yes, create it" then completes it.
   - The instructions ask Claude to keep confirmations to one or two sentences
     in voice.
5. **Minutes by voice.** Dictating notes right after a meeting works ("minutes
   for today's standup: we agreed …"). For a recorded meeting, plan on a
   transcript file, such as Teams, Meet or Zoom transcripts, rather than
   uploading the audio.

**To test in phase 2:**
- All four actions by dictation on iOS and Android, in English and in Arabic
  (keyboard dictation).
- The same in voice mode.
- How Claude's "allow this action?" prompt appears in voice mode.

## 6. Tools (version 1)

All names use snake_case and are under 64 characters. Every tool has `title`,
`readOnlyHint` and `destructiveHint`; `openWorldHint` is false. Each returns a
short text answer plus `structuredContent` with an `outputSchema`. Lists take
`cursor` and `limit` (default 25, maximum 100) and return `nextCursor`. Every
workspace tool takes `workspace` (id or name). It is optional only for people
with exactly one workspace (§5.5).

| Tool | Read-only | Destructive | Used by |
| --- | :-: | :-: | --- |
| `list_workspaces`: your workspaces, your role in each, and today's date and time zone in each. Starts each conversation for people with several workspaces (§5.5). | ✓ | | all |
| `list_people`: members of a workspace (name, email, role) | ✓ | | delegation, meetings, minutes sharing |
| `find_tasks`: your open, assigned, completed or (administrators) all tasks; search; due filters | ✓ | | general |
| `get_task` | ✓ | | general |
| `find_meetings`: by date range or search; past or upcoming; includes "you have minutes" | ✓ | | minutes, meetings |
| `get_meeting`: details, attendees, action items, your minutes if any | ✓ | | minutes |
| `get_minutes`: your minutes for a meeting, or minutes shared with you | ✓ | | minutes |
| `review_task_delegation`: validates and resolves names, returns a summary and draft handle (saves nothing visible) | ✓ | | a task for others |
| `review_meeting`: validates, resolves names, checks clashes, returns a summary and draft handle | ✓ | | a meeting |
| `create_my_task` | | | a task for yourself |
| `delegate_task`: takes the `draft` handle | | | a task for others |
| `create_meeting`: takes the `draft` handle | | | a meeting |
| `save_minutes`: create your minutes for a meeting, or replace them with `replace: true` | | ✓ | minutes |
| `set_task_status`: complete or reopen a task you can see | | | general |

Phase 3 adds three read-only tools whose results also show a card: `my_day`,
`choose_meeting` and `choose_people`. The two reviews show a card too.

There are no delete tools in version 1. Deleting stays in the app.

**Tools shown per person:** the tool list is built per request from the signed-in
person. People who are an administrator in no workspace never see
`review_task_delegation`, `delegate_task`, `review_meeting` or
`create_meeting`. For people who are an administrator in some workspaces
and a member in others, the tools are listed, and each call is checked for the
chosen workspace with Taskly's own permission functions.

**What tools return:**
- Ids and links back to Taskly, so you can open the item.
- Text written by other people (titles, notes, minutes) is returned as data in
  `structuredContent`, never as instructions. Tool descriptions contain no
  instruction-like text about other tools.

## 7. No slash commands

*Decided (§13.7).* The server registers no MCP prompts. Everything is
reachable by saying what you want (§4). Write tools need the `taskly.write`
scope. A read-only connection gets a 403 `insufficient_scope` step-up when it
tries to write.

## 8. Sign-in: Taskly becomes its own OAuth server

Taskly has no outside identity provider, so it issues its own tokens. It is
built as Next.js routes over D1/SQLite, so it runs the same on Cloudflare and
cPanel.

| Route | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata. `resource` is exactly `https://<host>/mcp`; `authorization_servers` is Taskly's issuer; `scopes_supported` is the minimal list. |
| `/.well-known/oauth-authorization-server` | Authorization server metadata: `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ["none"]`, plus a registration endpoint. |
| `/oauth/authorize` (page) | Sign in if needed, then a consent screen showing the app's **host** and redirect host (not just the name it claims) and what it may do. Allow or Deny. No workspace picker; that happens per conversation (§5.5). |
| `/oauth/token` | Accepts form-encoded requests. Supports `authorization_code` (PKCE S256, `resource` check) and `refresh_token` (rotating). Returns `invalid_grant` for dead tokens. |
| `/oauth/register` | DCR, kept because Claude falls back to it and other clients use it. Unused registrations are cleaned up. |
| `/oauth/revoke` | Revocation (RFC 7009). |

**Clients and redirects:**
- **CIMD:** when `client_id` is an HTTPS URL, Taskly fetches its metadata and
  checks that `client_id` matches the URL and the redirect is listed.
  - Fetch limits: 5 s timeout, 10 KB size cap, and private addresses blocked.
    On Cloudflare, `global_fetch_strictly_public` is already on; on Node, the
    fetcher must block private IPs itself.
  - Results are cached for a day.
- **Allowed redirects:** `https://claude.ai/api/mcp/auth_callback` exactly, and
  loopback `http://localhost` or `http://127.0.0.1` on any port (Claude Code).

**Tokens:**
- Opaque random tokens, stored only as SHA-256 hashes, like sessions.
- Access tokens last 1 hour. Refresh tokens last 60 days and rotate on every use.
- Each grant stores the user, client, scopes and `resource`.
- Every `/mcp` request checks:
  - the token hash and expiry;
  - that `resource` equals this server's URL;
  - that the user is still active;
  - that the grant isn't revoked.

**Scopes:**
- Two scopes: `taskly.read` and `taskly.write`. Asking for only `taskly.read`
  gives a read-only connection.
- Write tools answer an under-scoped token with 403 `insufficient_scope`, which
  makes the client ask for more access (step-up).

**Changes to existing code:**
- The login page accepts a same-origin `next=` path, so authorization can resume
  after signing in.
- The consent page approves by `fetch`, then navigates with
  `location.assign(redirect)`. This avoids the `form-action 'self'` CSP block
  without loosening it.
- Issuer, resource and redirect URLs come from `appOrigin()`, not the request
  URL. This matters behind cPanel's proxy, where the request URL may say
  `http://`. The Google OAuth routes have the same latent issue.

The **Set up MCP** section in Settings (§9a) lists each connection (app,
host, scopes, last used) with Disconnect.

*Decided (§13.4):* changing your password does **not** disconnect Claude.
Being deactivated or deleted revokes every connection, and you can disconnect
yourself from Settings at any time.

**Operators** get no special powers through the connector. It acts only where
the person is a member, as Google sync does with `actorFor`. Platform tools are
out of scope.

## 9. The `/mcp` endpoint

- `app/mcp/route.ts` (URL `https://<host>/mcp`) handles POST. GET and DELETE
  return 405.
  - It calls SDK v2's `createMcpHandler(factory, { responseMode: "json" })`, so
    there is no streaming. That suits cPanel/Passenger, and nothing in Taskly
    needs streaming.
  - The `factory` builds the server per request from the verified token: tools,
    prompts and instructions for that person.
- **Before the SDK runs:**
  - Reject a present but foreign `Origin` with 403.
  - Answer a missing or invalid token with 401 plus
    `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="taskly.read taskly.write"`.
- Tools call the existing `*As` service functions (`createTaskAs`,
  `applyTaskUpdate`, `createMeetingAs`, and new `…As` versions for minutes)
  with an `Actor` from `actorFor`. Validation, permissions, notifications,
  email, Google sync and translation therefore behave exactly as in the app.
- **Rate limit:** 60 tool calls per minute per connection, counted in D1/SQLite,
  answered with a tool error rather than HTTP 429.
- **Audit:** each write records the connection, tool and item. Notifications
  read "Aisha (via Claude) created …".

## 9a. "Set up MCP" in Taskly (with the Claude logo)

A new section on the **Settings** page, so anyone can connect Taskly to Claude
without knowing what a connector or MCP is. It also appears as a dismissible
"Connect to Claude" card on the dashboard until the person connects, and is
linked directly at `/settings#claude`.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ [Claude logo]  Set up MCP                                             │
│                Use Taskly from Claude: add tasks, take minutes and     │
│                schedule meetings by typing or speaking.                │
├──────────────────────────────────────────────────────────────────────┤
│ ① Copy your Taskly connector URL                                      │
│   [ https://<app address>/mcp                            ] [Copy]     │
│                                                                        │
│ ② Add it to Claude          ( Pro · Max · Free | Team · Enterprise )  │
│   Pro · Max · Free:                                                    │
│    1. [Open Claude connectors ↗]                                       │
│    2. Choose "Add custom connector".                                   │
│    3. Name: Taskly. URL: paste the link from step ①. Leave             │
│       "Advanced settings" empty.                                       │
│    4. Click Add, then Connect.                                         │
│    5. Sign in to Taskly if asked, then click Allow.                    │
│    Free plan: one custom connector only.                               │
│   Team · Enterprise:                                                   │
│    Only your Claude organisation owner can add it.                     │
│    [Copy a message for your owner]                                     │
│    Once it's added: Customize → Connectors → Taskly → Connect.         │
│                                                                        │
│ ③ Try it in a chat                                                     │
│   In a new chat, open + → Connectors and turn on Taskly.               │
│   [Copy] Remind me to renew the trade licence on Thursday              │
│   [Copy] Here are my notes from today's standup: write the minutes …   │
│   [Copy] Give Omar the venue booking, due Friday                       │ ← administrators
│   [Copy] Set up a budget review with Sara next Tuesday at 3 pm         │ ← administrators
│   You're in 2 workspaces: Claude will ask which one at the start       │ ← several workspaces
│   of each chat.                                                        │
│   You can speak instead of typing: tap the microphone in Claude.      │
│                                                                        │
│ ▸ Need help? Paste this into Claude                      [Copy prompt] │
│ ▸ For developers: Claude Code                                          │
│ ▸ Troubleshooting                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### States

| State | What it shows |
| --- | --- |
| **Not set up on this server.** No https App address, or the connector switched off in Platform → Settings. | One muted line: "Claude isn't available on this Taskly yet. Ask your platform operator." Operators also see a link to Platform → Settings. |
| **Not connected** | The three steps above. |
| **Connected.** The person has an active grant from a Claude client (recognised by its redirect host, `claude.ai` or loopback, and its CIMD client id). | "✓ Connected to Claude · last used 5 minutes ago" with Disconnect, the list of connections (for example "Claude (claude.ai)" and "Claude Code on a laptop"), and step ③'s starter prompts. Steps ① and ② fold into "Connect another Claude app". |

The page refreshes the state when it regains focus, so after people click
Allow in Claude and come back, it says Connected without a reload.

### The copyable "prompts"

The page has three kinds of copyable text, each with its own Copy button.

**1. Starter prompts.** They depend on the person's role and match §5:
members don't see the delegation and meeting ones.

**2. Message for the organisation owner** (Team and Enterprise plans):

> Hi! Could you add Taskly to our Claude organisation so we can use it in
> Claude? Go to **Organization settings → Connectors → Add → Custom → Web**,
> name it **Taskly** and use this URL: **https://&lt;app address&gt;/mcp**.
> Leave the authentication settings empty; each of us signs in with our own
> Taskly account. Thanks!

**3. "Need help? Paste this into Claude":** for people who get stuck. Claude
walks them through it in their own words.

> I want to connect Taskly to Claude as a custom connector. My connector URL
> is https://&lt;app address&gt;/mcp and I'm on the [Pro / Team / …] plan.
> Walk me through adding it one step at a time, wait for me to finish each
> step, and then help me check that it works by asking Taskly what's due this
> week.

### Other parts

- **Developers (Claude Code):** a copyable command,
  `claude mcp add --transport http taskly https://<app address>/mcp`, then "run
  `/mcp` and choose Authenticate".
- **Troubleshooting:**
  - "Claude can't reach Taskly": the URL must start with `https://` and end
    with `/mcp`.
  - "Sign-in keeps looping": allow pop-ups and cookies for Taskly.
  - "Taskly isn't in my chat": open + → Connectors and turn it on.
  - "Claude asks before every change": that's Claude's safety prompt. You can
    set Taskly's tools to Allow always in Claude's connector settings.
  - Arabic dictation: Claude's own dictation doesn't support Arabic yet; use
    your phone keyboard's microphone.

### Claude logo and links

- Use **Anthropic's official Claude logo** (SVG from Anthropic's brand or press
  resources), saved as `public/brand/claude.svg`. Show it unmodified at
  24–32 px with its own clear space.
- The wording describes Taskly as working *with* Claude. It must not suggest
  Anthropic endorses Taskly. Check Anthropic's current trademark and brand
  guidelines before release (§13 follow-up).
- "Open Claude connectors" links to `https://claude.ai/customize/connectors`.
  This is the page Anthropic's docs name; re-check it at build time, because
  product URLs change. There is no documented link that pre-fills the URL, so
  people paste it themselves.
- The link opens in a new tab with `rel="noopener"`.

### Strings

All copy goes in `messages/en.ts` and `messages/ar.ts`. Arabic needs a real
translation, not machine output. Claude's own menu names (Customize,
Connectors, Add custom connector) stay **in English** in both languages,
because that's what people see in Claude unless Claude itself is set to
Arabic.

### Server side

- `getClaudeSetup()` (RPC, signed-in user) returns:
  - `available`;
  - `connectorUrl`;
  - `role` in each workspace and the workspace count (to choose the starter
    prompts);
  - `connections: [{ id, app, host, scopes, createdAt, lastUsedAt }]`.
- `disconnectClaude(id)` revokes one grant.
- Platform → Settings gets a **"Claude connector: on/off"** switch, default on,
  shown only when the App address is https.

## 10. Data (migration `0017_claude_connector.sql`)

- `oauth_clients`: client id, kind (`cimd` or `dcr`), name, redirect URIs,
  cached metadata, `fetched_at`, `last_used_at`.
- `oauth_codes`: code hash, client, user, redirect, PKCE challenge, scopes,
  resource, expiry (60 s, single use).
- `oauth_grants`: id, user, client, scopes, resource, created, last used,
  revoked.
- `oauth_tokens`: token hash, grant, kind (`access` or `refresh`), expiry,
  `used_at` (lets refresh-token reuse be detected; reuse revokes the grant).
- `mcp_drafts` (phase 2, migration `0018_mcp_drafts.sql`): handle, user,
  workspace, kind, payload, expiry (15 min).
- `mcp_photo_links` (phase 3, migration `0019_mcp_photo_links.sql`): token
  hash, user, grant, expiry (1 hour). These are the photo links for cards.
- `mcp_rate` (phase 4): per-connection minute counters.
- `notifications.via`, or a field in the existing JSON data, for "via Claude".

Only `CREATE TABLE`, `CREATE INDEX` and `ADD COLUMN`, so it works on D1 and on
cPanel's migration runner.

## 11. Phases

| # | Phase | Result |
| --- | --- | --- |
| 1 | ✅ OAuth server, `/mcp`, read tools, and the **Set up MCP** section (§9a) | Anyone can follow the in-app steps to add the custom connector, then ask "what's due this week?" |
| 2 | ✅ **Write actions in plain language** | The four actions in §5 (a task for yourself, minutes, a task for others, a meeting), plus completing or reopening tasks. Server-enforced reviews for delegation and meetings, forgiving name matching, spoken summaries, and new starter prompts in Set up MCP. |
| 3 | ✅ **Interactive cards in the Claude apps** (MCP Apps) | A meeting picker for minutes, a people picker with photos, review cards with Create and Discard (clashes highlighted; changes are made by telling Claude), and a "My day" card where tasks can be ticked. Web, desktop and mobile; Claude Code and voice fall back to text. |
| 4 | Hardening | Platform on/off switch, a DCR rate limit and cleanup of unused registrations, a per-connection rate limit, an audit trail and "via Claude" in notifications |
| 5 | Optional | A ready-made **Claude Project** for teams (instructions plus the minutes template). Separately, **AI inside Taskly** (Claude API) for people who don't use the Claude app: "write minutes from my notes", "turn these notes into tasks". Not planned: slash commands, a Connectors Directory listing. |

## 12. Testing

- **Unit tests** (`node --test`, as today): PKCE verification, redirect
  matching (exact and loopback), CIMD document checks, scope checks, token
  rotation and reuse detection, and the date/time and name-matching helpers.
- **Locally:**
  - MCP Inspector, or `claude mcp add --transport http taskly http://localhost:3100/mcp`.
  - A script using `@modelcontextprotocol/client` that signs in, runs each
    workflow, and checks the database.
- **claude.ai** needs public HTTPS: use a Cloudflare preview deploy or a
  `cloudflared` tunnel, add it as a custom connector, and try all four actions
  in plain language, as an administrator and as a member.
- **Set up MCP:**
  - Each state renders in English and Arabic.
  - Starter prompts depend on role.
  - The URL comes from the App address.
  - After you allow access in Claude, the page shows Connected.
  - Disconnect revokes the grant: the next tool call gets 401 and Claude asks
    to reconnect.
- **Permissions:** a member can't delegate, create meetings, or see other
  people's private tasks or minutes; a token for one user never touches another
  user's data; a revoked or expired token gets 401.

## 13. Decisions (made 2026-10-13)

1. **A task for yourself:** always a private task ("mine"), for
   administrators too.
2. **Members asking for a meeting:** Claude declines. No personal-calendar
   fallback.
3. **Workspace:**
   - One workspace is used automatically.
   - With several, each conversation starts by picking the workspace, and the
     server enforces this (§5.5).
4. **Password change:** doesn't disconnect Claude. Deactivation, deletion and
   Disconnect do.
5. **Official URL:** the Cloudflare deployment, `<App address>/mcp`.
6. **Distribution:** custom connector only. People add it themselves using
   the in-app **Set up MCP** guide (§9a).
7. **No slash commands:** people say what they want in plain language (§4).
   Phase 2 is the write actions, and phase 3 is interactive cards.

**Follow-up before release:** confirm Anthropic's current brand and trademark
guidelines for showing the Claude logo (§9a).

## 14. Sources

- Claude connectors:
  - [Authentication](https://claude.com/docs/connectors/building/authentication)
  - [Building connectors](https://claude.com/docs/connectors/building/index)
  - [MCP Apps](https://claude.com/docs/connectors/building/mcp-apps/getting-started)
  - [Review criteria](https://claude.com/docs/connectors/building/review-criteria)
  - [Submission](https://claude.com/docs/connectors/building/submission)
  - [Adding a custom connector](https://claude.com/docs/connectors/custom/add-unlisted)
  - [Getting started with custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- MCP spec 2026-07-28:
  - [Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
  - [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
  - [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
  - [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
  - [Security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- TypeScript SDK v2:
  - [Serving over HTTP](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
  - [Authorization](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
  - [Tools](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md)
- MCP Apps: [overview](https://modelcontextprotocol.io/extensions/apps/overview) and [client matrix](https://modelcontextprotocol.io/extensions/client-matrix)
- Claude Code: [MCP](https://code.claude.com/docs/en/mcp)
- Claude API: [MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
