# Plan: Trilingual meeting agendas (English · العربية · اردو)

Status: proposal; nothing is implemented. Written 2026-10-11 against commit
`85b2280`. This plan stands on its own; Google sync is a separate plan:
[plan-google-sync.md](plan-google-sync.md).

## 1. Requirement

When someone writes a meeting agenda in English, Arabic or Urdu, Taskly also
produces the agenda in the other two languages. Translation uses the 600M-parameter
model **NLLB-200 distilled 600M** (`facebook/nllb-200-distilled-600M`), running on
our own server rather than through a paid translation API.

The agenda is `meetings.notes`: the form's placeholder is "Agenda, decisions,
context", and it holds up to 20,000 characters (`server/validate.ts`).

> **License check first.** NLLB-200 is **CC-BY-NC 4.0 (non-commercial)**. If Taskly
> or Zawyh is sold to clients, that counts as commercial use. The model sits behind
> the service API in §3, so it can be swapped without changing the app. Options:
> `google/madlad400-3b-mt` (Apache-2.0, heavier) or the Helsinki-NLP `opus-mt`
> en↔ar and en↔ur pairs (small and commercial-friendly).

## 2. Constraints found in the code

- **The Worker can't run the model.** The app is a Cloudflare Worker, so the model
  runs as a separate service and the Worker calls it with `fetch`.
  `global_fetch_strictly_public` is on, so that service needs a public HTTPS
  address.
- **Writes go through two functions.** Meeting writes go through `createMeeting` and
  `updateMeeting` in `server/services/meetings.ts`. That is where translation work
  gets queued. Saving a meeting must never wait for it.
  - If [Google sync](plan-google-sync.md) ships, agenda edits can also arrive from
    Google Calendar.
  - That plan splits each write into an RPC wrapper and an internal function.
    Translation must be queued in the **internal** function, so edits from Google
    are re-translated too.
  - Personal Google events are not translated.
- **No Urdu UI.** The UI only has `en` and `ar` (`messages/`, `lib/i18n`). This plan
  translates agenda *content* only. A full Urdu UI would be a separate change.
- **Cron.** `custom-worker.ts` has a `scheduled` handler (`0 * * * *`). Retries need
  a faster schedule: add `*/5 * * * *` and branch on `controller.cron`. If the Google
  sync plan has already added it, reuse it.

## 3. Translation service on EC2

- **Instance.**
  - Start with a `t3.large` (2 vCPU, 8 GB).
  - `t3` is burstable, and sustained use drains its CPU credits. Move to a
    `c7i.large` or `m7i.large` if translations start to queue.
- **Stack.**
  - Python, FastAPI and **CTranslate2**, running an int8 conversion of the model:
    `ct2-transformers-converter --model facebook/nllb-200-distilled-600M --quantization int8`.
  - On a CPU this is much faster and uses much less memory than plain
    `transformers`.
- **Security.**
  - HTTPS through Caddy, with automatic Let's Encrypt certificates.
  - An `Authorization: Bearer <TRANSLATE_API_KEY>` check on every request.
  - Only two routes: `GET /health` and `POST /translate`.
  - Request limits: at most 200 segments and 64 KB per request.
- **Code and deployment.** The code lives in this repo under
  `services/translate/` (`app.py`, `requirements.txt`, `Dockerfile`, `Caddyfile`).
  It deploys separately from the Worker, using Docker on the instance.

```http
POST /translate
Authorization: Bearer …
{ "source": "urd_Arab", "targets": ["eng_Latn", "arb_Arab"], "segments": ["…", "…"] }
→ { "model": "nllb-200-distilled-600M-int8", "translations": { "eng_Latn": ["…"], "arb_Arab": ["…"] } }
```

NLLB language codes: `eng_Latn`, `arb_Arab`, `urd_Arab`.

Worker config:

| Name                | Kind   | Purpose                                      |
| ------------------- | ------ | -------------------------------------------- |
| `TRANSLATE_URL`     | var    | Base URL of the service                      |
| `TRANSLATE_API_KEY` | secret | Bearer token (also put it in `.dev.vars` locally) |

## 4. Detecting the source language

Arabic and Urdu share a script, so the script alone isn't enough. The rules, in
`server/translate/detect.ts` (a pure function):

- Mostly Latin letters → **English**.
- Otherwise, count two sets of letters:
  - Urdu-only: `ٹ ڈ ڑ ں ے ۓ ہ ھ`, the Farsi yeh `ی` (U+06CC), the keheh `ک`
    (U+06A9), and `گ پ چ`.
  - Arabic-only: `ة ى`, the Arabic yeh `ي` (U+064A) and the Arabic kaf `ك`
    (U+0643).
- Whichever set has more matches decides **Urdu** or **Arabic**.
- The meeting form gets a small **"Written in"** select, pre-filled from this guess,
  so the author can correct it. The result is stored as `meetings.notes_lang`.

## 5. Segmenting the agenda

Agendas are lists, so they're translated **line by line**
(`server/translate/segment.ts`, a pure function):

- Bullets and numbering (`-`, `•`, `1.`, `١.`), times, URLs, emails and `T-12`
  references are kept as they are. Only the text between them is translated.
- Long lines are split at sentence ends, so each segment stays well under NLLB's
  input limit.
- Empty lines are kept, so the translated layout matches the original.
- A segment that is only a number, time or link isn't sent to the model.

## 6. Storage and flow

```sql
-- migrations/0007_agenda_translations.sql (renumber if Google sync lands first)
ALTER TABLE meetings ADD COLUMN notes_lang TEXT CHECK (notes_lang IN ('en', 'ar', 'ur'));

-- One row per meeting and target language. The rows double as the work queue.
CREATE TABLE meeting_translations (
  meeting_id      TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  lang            TEXT NOT NULL CHECK (lang IN ('en', 'ar', 'ur')),
  text            TEXT NOT NULL DEFAULT '',
  source_hash     TEXT NOT NULL,           -- SHA-256 of the notes it came from
  status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  model           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (meeting_id, lang)
);
CREATE INDEX meeting_translations_due ON meeting_translations (status, next_attempt_at);
```

1. **Save.** `createMeeting` and `updateMeeting` save `notes` and `notes_lang`.
   - If the notes changed, the same D1 batch upserts the other two languages as
     `pending`, with the new `source_hash`.
   - If the notes are empty, the batch deletes the translation rows instead.
2. **Kick off.** After saving, `ctx.waitUntil(translateMeeting(ctx, meetingId))`
   starts the work. The response doesn't wait for it.
3. **Translate.** `translateMeeting` segments the notes and calls `/translate` once
   with both target languages, then writes each language back.
   - The write-back only happens while `source_hash` still matches. If the agenda
     was edited mid-flight, the stale result is dropped.
4. **Retry.** The 5-minute cron picks up rows that are `pending` with
   `next_attempt_at <= now`, or `failed` with fewer than 5 attempts. Retries back
   off at 1 m, 5 m, 30 m and 2 h.
5. **Read.** `getMeeting` returns
   `agenda: { original: { lang, text }, translations: [{ lang, text, status }] }`.

Server files:

- `server/translate/client.ts`: the `fetch` call to the service, with a timeout.
- `server/translate/detect.ts` and `server/translate/segment.ts`: the pure functions
  from §4 and §5.
- `server/services/translations.ts`: `translateMeeting`, the cron drain, and an RPC
  method `retranslateMeeting` (administrators only).

## 7. UI

- **Meeting form.** Add the "Written in" select next to Notes, auto-filled as the
  author types.
- **Meeting panel.** The agenda gets tabs: **English | العربية | اردو**.
  - It opens on the viewer's language when that version exists: UI locale `ar`
    opens Arabic, `en` opens English. Otherwise it opens on the original.
  - Translated tabs show "Machine translated · View original".
  - While a translation is pending, its tab shows "Translating…", and React Query
    refetches every 3 seconds until it's done.
  - A failed tab says so; administrators can use **Translate again** from there.
- **Direction and fonts.** Arabic and Urdu blocks get `dir="rtl"`. Urdu uses
  **Noto Nastaliq Urdu** (Google Fonts) with a taller line height, because Nastaliq
  needs it.
- **Strings.** Add the new strings to `messages/en.ts` and `messages/ar.ts`.
- Editing translations by hand is out of scope for v1.

## 8. Roadmap

| #  | Phase                        | Main work                                                                                     | Depends on |
| -- | ---------------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| 1  | Model decision and prototype | Settle the license (§1); run the model locally on 20 real agendas; check quality and speed     | –          |
| 2  | Translation service          | `services/translate/`, CTranslate2 int8 conversion, EC2 + Caddy + bearer auth, health check     | 1          |
| 3  | App backend                  | Migration, detect + segment with unit tests, `translateMeeting`, cron retries, `getMeeting` shape | 2          |
| 4  | UI                           | "Written in" select, agenda tabs, RTL and the Nastaliq font, pending and failed states         | 3          |
| 5  | Hardening                    | Logs and alerts on failed rows, rate limits, keeping the EC2 instance updated, a cost check    | 4          |

## 9. Testing

- **Unit tests** for `detect.ts` and `segment.ts`, using mixed bullets, numbering in
  Arabic digits, URLs and `T-n` references.
- **A golden set** of about 20 real agendas (EN, AR and UR). Check that list
  structure, times and references survive translation, and have a native reader
  spot-check quality for each language pair.
- **Locally,** run the service with `docker run` on your machine, set
  `TRANSLATE_URL=http://localhost:8000` in `.dev.vars`, and confirm a saved meeting
  goes from pending to done.
- **Failure handling:** stop the service, save a meeting, and confirm it is `failed`
  after retries. Start the service again and confirm **Translate again** works.

## 10. Decisions needed

1. **License:** is this commercial use? If yes, use MADLAD-400 3B or opus-mt instead
   of NLLB.
2. **Meeting titles:** translate them too (short and cheap), or only the agenda?
3. **Editing:** should administrators be able to correct a translation by hand
   (v2), or only re-run it?
4. **Hosting:** EC2 as planned, or a GPU instance (`g4dn.xlarge`) if agendas are long
   and frequent?
