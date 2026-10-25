# Live meetings (Phase 1 + 3): capture, live transcript, review into minutes

Status: **implemented** (2026-10-22) — migrations, token-authenticated device
endpoints, tokens in Settings, the live transcript panel, the replay CLI,
server-side/on-device summarization, and the review card that turns a draft
into minutes + action-item tasks. §8 lists what this build deliberately ships
without.

## 1. What this does

Taskly gets a **read-only view of what was said in a meeting, while it is being
said**. A person runs the Taskly desktop engine on their machine ("the
recorder"); it hears the meeting's audio, transcribes it speech by speech, and
pushes each segment to Taskly. Segments carry the spoken line plus its English
and Arabic renderings (`text_en`, `text_ar`): the spoken language fills its own
slot and a translator fills the other (§1.1). The meeting panel's live
transcript shows each reader their own language first, with the spoken line
underneath, whoever is reading, in any of the app's locales.

| | Where it lives |
| --- | --- |
| Who records | The owner of a device token (Settings → **Live capture**) |
| What a session is | One recording: a claimed meeting or an ad-hoc "Rehearsal" |
| Who reads a claimed session | The recorder, then the meeting's organizer, attendees and workspace administrators (`server/live/access.ts`) |
| Who reads an ad-hoc session | The recorder alone |
| Where the panel is | Meeting detail → "**Live transcript (beta)**" (reads only) |
| Where tokens are managed | Settings → Live capture: create, one-time reveal, revoke |
| Retention | Everything stays until the Phase 5 retention sweep |

Transcripts are people's speech. The server stores them, shows them to the
people above, and logs **only ids and counts** — never segment text.

### 1.1 Architecture and trust boundary

The engine (`desktop-engine/`, see its README) runs on the meeting laptop, on
Windows, macOS or Linux. A GPU PC is optional. Run with `--server`, the laptop
hands the speech work (transcription, translation) and the summary to that
PC's **model server**, and keeps everything else. Without `--server`, the
laptop does all of it itself.

```
┌────────────────────────────────────────────────┐
│ People: a browser, on any device               │
│ live transcript panel and the review card      │
└────────────────────────────────────────────────┘
                        ↕ signed-in RPC (cookie): the panel and the card
┌────────────────────────────────────────────────┐
│ Taskly: the app and /api/live/*                │
│ keeps segments, drafts, minutes and tasks      │
└────────────────────────────────────────────────┘
                        ▲ text only: push (text, text_en, text_ar, timings)
                        │ and the draft; Bearer <device token>
┌────────────────────────────────────────────────┐
│ Meeting laptop: the engine                     │
│ mic + system audio -> VAD -> journal -> push   │
└────────────────────────────────────────────────┘
                        ▼ audio of one utterance, or a summary prompt
                        ▲ text, text_en, text_ar, or the summary
                        │ Bearer <server key>; never the Taskly token
┌────────────────────────────────────────────────┐
│ GPU PC: the model server (serve)               │
│ Whisper -> translator -> text_en, text_ar      │
│ Ollama -> summary (/v1/complete)               │
└────────────────────────────────────────────────┘
```

**Trust boundary.**

- Taskly receives **text only**: lines, timings and the review draft. It
  never receives audio.
- The device token stays on the laptop. The GPU PC never sees it, and never
  sees a session id or a meeting id.
- The GPU PC holds no meeting state. Its requests carry audio or a summary
  prompt, plus the server key, which is a password for the PC's models and
  not a Taskly credential.
- The laptop's journal is the only record of a line before it reaches Taskly.

**One line, end to end.**

1. The laptop cuts an utterance from the mic or the system audio (VAD, at
   most 30 s).
2. With a GPU PC, the utterance's audio goes to it. Whisper transcribes it,
   and the translator (or Whisper's own English pass, when no translator
   runs) supplies the other language. The reply carries `text`, `lang`,
   `text_en` and `text_ar`.
3. The laptop appends the line to its journal, with its `seq`, before
   anything is sent.
4. The pusher sends it to `POST /api/live/push` under the device token, with
   `text`, `text_en`, `text_ar`, `lang`, `source` and the timings.
5. Taskly stores it, and the panel shows the reader's own language first.
   `text_ar` stays empty for an English line unless a translator ran.
6. At the end, the laptop sends the transcript lines to the PC for the
   summary, and posts the draft to `POST /api/live/sessions/{id}/draft`. The
   review card then accepts it.

## 2. The token flow

1. In Settings → **Live capture** the person names a device and (if they are
   in several workspaces) picks the workspace. They get a token shaped
   `tsk_lv_<64 hex>`, **shown once**; the server stores only its SHA‑256
   (`server/crypto.ts`, same as session tokens).
2. The desktop engine holds the token and sends it as
   `Authorization: Bearer …` on every device call. It can start sessions, push
   segments and end them — nothing else.
3. Tokens are per **person and workspace**, and have no expiry in v1. A token
   is revoked as soon as the person is deactivated, deleted, or leaves (or is
   removed from) the workspace (`server/live/tokens.ts`), so a later re-invite
   or reactivation never brings an old token back; a lost token otherwise
   stays listed until its owner revokes it. Revocation keeps the row
   (`revoked_at` set), so a revoked token answers **403**, not 401 — the
   recorder knows exactly why its pushes stopped working.

## 3. The device contract (server ↔ recorder)

All calls are `POST`, JSON in/out, error bodies `{ "error": "<code>" }` with
the statuses below. The documented shapes are exactly what's implemented —
the engine team builds against this text.

### `POST /api/live/sessions` — start a recording

Request:

```json
{ "meeting_date": "2026-10-22", "meeting_id": "meeting-…", "meeting_title": "Weekly" }
```

- `meeting_title` (≤200, non-blank) and `meeting_date` (`YYYY-MM-DD`) are
  snapshots; with a `meeting_id` (≤100) the server copies the meeting's own
  title and date instead, and the caller must be able to see the meeting.
- Response `200 { "session": { "id": "live-…", "accountId",
  "meetingId", "meetingTitle", "meetingDate", "recorderId", "status":
  "capturing", "startedAt", "endedAt", "lastSeenAt" } }` (dates in ISO).
- `401` unknown token · `403` revoked token, deactivated person, or a person
  no longer in the token's workspace · `404` claimed meeting is unknown or
  invisible to the caller · `400` malformed body (not JSON included).

### `POST /api/live/push` — batch of segments, idempotent

Request:

```json
{
  "session_id": "live-…",
  "segments": [
    {
      "seq": 12,
      "source": "mic",
      "lang": "ar",
      "text": "…",
      "text_en": "…",
      "text_ar": "…",
      "started_at": 6000,
      "ended_at": 7800
    }
  ]
}
```

- `seq` is unique per session (`UNIQUE (session_id, seq)`), an integer 1…2³¹−1;
  repeats are **ACK'd, never an error** — a duplicate sid keeps the row of the
  first copy. ≤200 segments per batch (empty batches allowed), `text`,
  `text_en` and `text_ar` ≤4000 (`text_en`/`text_ar` optional: the line
  translated into English and into Arabic; older engines send only
  `text_en`), `lang` ≤20, `source` is `mic` or `system`, `started_at`/
  `ended_at` are epoch-milliseconds from the session start (≤2³¹−1),
  `ended_at ≥ started_at`. `lang` is the device's own guess ("ar", "en").
- Response `200 { "accepted": "<count>", "last_seq": <n> }`.

  Note the two shapes of note: `accepted` is a **string** (the count of
  entries in this batch, including repeats, all of which are stored) and
  `last_seq` is the highest seq **within the batch just sent** (0 for an empty
  batch) — not the session's running total. A device that pushes `1,2,3` after
  never having pushed anything still reads `last_seq: 3`; it learns the
  session's real high-water mark from `GET`-equivalent reads (`liveTranscript`
  RPC) rather than from push replies.
- `401` unknown token · `403` revoked/deactivated, **or someone else's
  session** · `404` unknown **or already ended** session · `429` over the rate
  limit (§6) · `400` malformed body.

### `POST /api/live/sessions/[id]/end` — stop recording

- Response `200 { "session": { …, "status": "ended"? } }`. Ending an
  already-ended session is a **no-op** returning it; a fresh session ends to
  `"reviewing"`. Pushing to an ended session reads as 404 like any unknown
  one.
- Same `401`/`403`/`404` semantics as push.

### `POST /api/live/sessions/[id]/draft` — the device's own review draft

The engine's locally generated draft (Ollama on the person's PC, or on the
GPU PC's model server when the engine uses one; the engine
posts it on its own when a recording linked to a meeting ends, see
`desktop-engine/README.md`); the server stores it as the session's single
unconsumed draft for **7 days** (the review card's accept consumes it). A
draft the server makes itself lasts 15 minutes, since Summarize can make it
again; only the device can remake its own (`python -m taskly_live summarize
<session>`).

```json
{
  "sections": {
    "summary": "…",
    "decisions": ["Ship on the 26th."],
    "follow_ups": ["Budget call next week"]
  },
  "action_items": [
    { "title": "Draft the announcement", "assignee": "Thouseef", "due": "2026-10-26" }
  ]
}
```

- Caps: `summary` ≤20000, `decisions`/`follow_ups` ≤25 × ≤500 chars,
  `action_items` ≤30 × `title` ≤200 (`assignee` ≤100, `due` `YYYY-MM-DD`).
- Only while the session is `reviewing`; a repeat replaces the previous
  unconsumed draft (a regenerate never leaves two). Same auth/status rules as
  push.
- Response `200 { "draft": { id, sessionId, expiresAt, …payload } }`.

## 4. What people use (the server's RPC methods)

Cookie-authenticated JSON‑RPC, as for minutes and meetings
(`server/api.ts`, client `lib/api/live.ts`):

| Method | Talks |
| --- | --- |
| `liveSessions()` | The caller's recordings, newest first (`live.*` panel uses these) |
| `liveTranscript(sessionId, afterSeq?)` | `{ session, segments }` — segments with `seq > afterSeq` (`0` when absent), ascending, capped at 500 per read |
| `createLiveDeviceToken({ workspaceId?, name })` | Secret `{ token, device }` — the token is shown exactly once |
| `liveDeviceTokens()` | Devices (name, workspace, last used) — no secrets |
| `deleteLiveDeviceToken(id)` | Revoke (alive again? No — it can't be undone) |
| `liveSummarize(sessionId)` | Recorder only. With a server provider configured (Platform → Settings → Live meetings → Summaries) generates + saves the draft; with `on-device` returns the engine's posted draft, or `summaryOnDevice` while it hasn't arrived; `summarizerUnavailable` (a service set up incompletely) / `summarizeFailed` otherwise |
| `liveDraft({ sessionId })` | Recorder only. The current draft (`null` when none/expired) — the card polls it |
| `liveAccept({ sessionId, draftId?, visibility, sharedWithIds?, note?, items? })` | Recorder only. Rule pass against the draft the card shows (`draftId`; a newer draft in between → `liveDraftGone`) → consumes it (single use) → creates the recorder's minutes + one task per action item, linked to the meeting. Minutes are `private` for members; `workspace`/`people` need an administrator (engine-written text, stricter than hand-typed minutes). A name that matches nobody, matches twice, or names someone the member can't appoint leaves the task **unassigned** with the name in its description — for a member it becomes their own **private** task instead, since members can't see unassigned workspace tasks. A single close match ("Omer" → Omar) is assigned with a note saying who was understood. Refusals (bad assignee ids from the card, an empty draft with no note, existing minutes) never spend the draft, and a failure writing the minutes gives it back |
| `liveDiscard({ sessionId })` | Recorder only. Drops the draft unconsumed; status → `done` (accept also moves it to `done`) |

Reads other than the recorder's follow the meeting and workspace rules from
§1: a person who left a workspace, or a viewer of an unrelated workspace, gets
the same "not found" the rest of the app uses to hide things.

## 5. Where the pieces live

| Path | What it is |
| --- | --- |
| `migrations/0020_live_meetings.sql` | `live_sessions`, `live_segments`, `live_device_tokens` (hashes; `account_id`; `revoked_at`) |
| `migrations/0021_live_drafts.sql` | `live_drafts` — one unconsumed, 15-minute draft per session |
| `server/services/live.ts` | Auth + device endpoints + summarize/draft/accept/discard RPCs |
| `server/live/{push,rate-limit,access,drafts,review}.ts` | Pure logic, unit-tested (`server/live/*.test.ts`); `review.ts` is the accept rule pass (visibility, assignees, task planning) |
| `server/live/tokens.ts` | Revokes a person's device tokens when they leave a workspace, are deactivated or deleted |
| `server/live/http.ts` | The routes' error mapping (401/403/404/429) and id-only logging |
| `server/summarize/{providers,prompt}.ts` | Provider picker (on-device, Claude, OpenAI-compatible, Workers AI) + strict-JSON prompt/parse, unit-tested |
| `app/api/live/**` | The four device routes (sessions, push, draft, end) |
| `features/settings/live-capture.tsx` | Settings section |
| `features/live/{hooks,live-transcript-section,session-review-card}.tsx` | The live transcript + the review card (minutes visibility, action items with assignee overrides) |
| `features/platform/components/settings-page.tsx` | Platform → Settings → Live meetings → Summaries (provider + **Test summary**) |
| `scripts/replay-live.mjs` | Replay CLI: a scripted recorder for tests |
| `desktop-engine/taskly_live/{recorder,pusher,journal,api}.py` | The engine's pipeline and its client for the device routes above |
| `desktop-engine/taskly_live/{server,remote}.py` | The GPU PC's model server (`serve`) and the laptop's client for it (§1.1) |

## 6. Rate limit (best-effort, per pod)

`/api/live/*` allow a burst of **30 calls per person**, refilling at **1 call
per 3 seconds** (a medium meeting pushes every few seconds and stays in
budget). Held in the process's memory: on Cloudflare that is per isolate and
resets on deploy, and the cPanel build has one process. It exists to blunt a
runaway device; metering and per-token backpressure are Phase 5.

## 7. How to test locally

```sh
yarn db:migrate:local          # applies 0020 + 0021 to the local SQLite D1
yarn dev                        # http://localhost:3100
# …open Settings → Live capture, create a token, copy it (shown once)…
node scripts/replay-live.mjs --url http://localhost:3100 \
  --token tsk_lv_…  [--dry-run] [--live] [--batch 50] [--reset]
```

The replay script starts a session (choose `--meeting <id>` to claim one),
pushes the built-in 5-line sample (or `--file lines.jsonl` of
`{"source","lang","text","text_en"}` rows), and ends the session. Progress is
kept in a temp state file keyed by URL + token hash — reruns after a crash
continue the SAME session from the last acked seq, which is exactly the
idempotent-push property the contract promises; `--reset` records a fresh
scenario. Watch the meeting panel for the live section (or the Settings list
for last-used ticks).

Two more helpers cover the rest of the smoke:

```sh
node scripts/make-smoke-token.mjs            # SQL for a token row + its raw token in .wrangler/
yarn wrangler d1 execute DB --local --file .wrangler/live-token.sql
node scripts/smoke-live.mjs --token <raw> [--foreign-token <raw>]
```

`smoke-live.mjs` walks the whole §3 status table against a running server:
idempotent repeats, empty batches, unknown session (404), malformed seq (400),
someone else's token (403), missing/wrong token (401), end-twice no-op, push
after end (404), then signs in as the demo person and reads the transcript
over the RPC cookie (liveSessions, liveTranscript cursor reads, 401 without a
session).

Login as a seeded person (`admin@example.com` / `admin1234` in the seed), or
insert a token row directly as above.

The review flow can be exercised without any cloud key: post a draft through
the device route (shape in §3) or set the provider to `on-device` and let the
engine post its draft, then open the meeting panel — the **review card**
appears for the recorder. Accept writes the minutes + linked tasks; verify
with `yarn wrangler d1 execute DB --local --command "SELECT ..."`.

`yarn test` runs the unit suites, including `server/live/*.test.ts` and
`server/summarize/*.test.ts`. The desktop engine has its own:
`desktop-engine/.venv/Scripts/python -m pytest` (see `desktop-engine/README.md`).

## 8. What is deliberately NOT in yet

- **Audio upload / storage** — Taskly never receives audio. With a GPU PC
  (§1.1), the laptop sends each utterance to that PC's model server, which
  holds the audio only while it decodes it. Nothing is stored.
- **Per-device backpressure and retention** (Phase 5); today's cap is the
  pod-local §6 burst only, and finished transcripts stay until the sweep
  exists.
- **Picking the meeting on the device** — the engine records into a meeting
  only when given its id (`--meeting <id>`, the `?meeting=` value in the
  app's URL); without one the recording is a private rehearsal with no
  review card. A meeting picker belongs to the desktop app.
- **Wider live readers** — the panel consumes `liveSessions()` (the
  recorder's own list). The read matrix is implemented and tested, but
  listing other people's live sessions per meeting arrives with the
  collaborators' integration.

## 9. Deviations from §4 of the plan

- `live_device_tokens` adds **`account_id`** (which workspace the token
  belongs to) — required to hand-recording to the requested workspace and to
  show workspace names in Settings; the plan's table had the user only.
- Adds **`revoked_at`** so revocation answers **403** ("this token was
  revoked") instead of 401 ("no such token") — tokens keep their row on
  revoke.
- `accepted` in the push reply is a **string**, per the shared contract the
  engine team codes against (`"<count>"`).
- The panel builds on `liveSessions()` only (the recorder's own list), but the
  **permission matrix** (`server/live/access.ts`) is implemented and tested
  for the full set of readers described above — the wider transport (listing
  other people's sessions per meeting) arrives with the collaborators'
  integration.
