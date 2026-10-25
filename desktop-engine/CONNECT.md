# Connect a platform to the AI server

The GPU PC runs the models for every platform you build. A platform connects
with **one URL and one key**. This page is for the developer of that platform,
whether it is hosted on cPanel or runs on a laptop.

> **Status.** The tailnet URL works. The public URL (Tailscale Funnel, §7) is
> **not enabled yet**. Examples in §4 and the reboot test in §8 are written
> from the server code and have **not** been run against the live server yet.

---

## 1. What you get

One URL and one key per platform. The server speaks the OpenAI API, so the
stock OpenAI SDKs work with only a base URL and a key.

| Route | What it does |
| --- | --- |
| `GET /v1/models` | Chat models available now, plus the Whisper models |
| `POST /v1/chat/completions` | Chat through Ollama. `"stream": true` is supported |
| `POST /v1/audio/transcriptions` | Audio file to text (Whisper) |
| `POST /v1/audio/translations` | Audio file to English text |
| `POST /v1/translate` | **Not OpenAI.** `{text, source?, target}` to `{text, source, target, translator}`, Arabic and English only |
| `GET /v1/health` | Status. Without a key: `{"ok": true}`. See §8 |
| `POST /v1/transcribe`, `POST /v1/complete` | The Taskly meeting recorder's own routes (§6). Not for platforms |

**Models**

- **Chat:** only the Ollama models on the server's allowlist (`serve --chat-models`).
  The default is the summary model, `qwen3.5:4b`. `GET /v1/models` lists only
  the ones Ollama has installed right now.
- **Audio:** Whisper large-v3-turbo on the GPU. Send any `model` value, for
  example `whisper-1`. The value is ignored.

**Limits**

| Limit | Value |
| --- | --- |
| Audio upload | 25 MiB (26 214 400 bytes) per request |
| Audio length | 2 hours after decoding. Longer is refused with 413 |
| Chat request body | 4 MB |
| `/v1/translate` text | 20 000 characters |
| Recorder audio (`/v1/transcribe`) | 35 s per request |

---

## 2. Get a key

Run these in PowerShell on the PC, from `desktop-engine`:

```powershell
.\.venv\Scripts\python.exe -m taskly_live serve keys add <platform-name>
.\.venv\Scripts\python.exe -m taskly_live serve keys list
.\.venv\Scripts\python.exe -m taskly_live serve keys revoke <platform-name>
```

- **`add`** prints the key **once**. Store it in the platform's secrets.
  `--concurrency N` sets this key's own limit per queue (default 1, see §5).
- **Names:** 1 to 64 characters. Lowercase letters, digits, `-`, `_` and `.`,
  starting with a letter or digit. Examples: `taskly-laptops`, `taskly-web`.
- **`list`** shows each key's state, creation date, last use, request count,
  audio minutes and tokens.
- **`revoke`** stops that key at once. Other keys are not affected. The name
  can be issued again later.
- **Storage:** `desktop-engine\server-keys.json`. Only SHA-256 hashes are
  stored. Keys are `tsk_` plus 32 random bytes (256 bits).
- **No restart needed.** The running server re-reads the key file within about
  2 seconds of a change, when the next request arrives. A request that lands
  in that window right after `add` can still get 401, so retry after a few
  seconds.
- **The old key.** The former `model-server.key` was imported once as
  `taskly-laptops`, so existing laptops keep working. The file is no longer
  consulted after the import. A revoked `taskly-laptops` stays revoked.
- `serve --new-key` no longer exists. It exits with an error.

---

## 3. The URL

- **Tailnet:** `http://<pc-100.x-address>:8765/v1`. Get the address with
  `tailscale ip -4` on the PC. The server also prints its addresses at start.
- **Public — the URL platforms use** (decided 2026-10-25: Tailscale Funnel's
  `.ts.net` name; live once §7 is done): **`https://<machine>.<tailnet>.ts.net/v1`**
  *(not set up yet — this line gets the real name when Funnel is enabled)*.

Use the `/v1` form as the SDK base URL. **Never put the key in a URL.** Send it
as `Authorization: Bearer <key>`.

---

## 4. Examples

Replace `<pc-url>` with the base URL from §3, and read the key from an
environment variable on your side. The Python SDK calls below (chat, streamed
chat, transcription in json/verbose_json/srt, audio translation) and the
`/v1/translate` request were run against the live server on 2026-10-25 with
`openai` 3.37; the JS, curl and PHP snippets follow the same shapes but weren't
run.

Chat models here are thinking models (qwen3.5): unless the request sets
`reasoning_effort` (or `reasoning`), the server sends `reasoning_effort: "none"`
so the answer comes straight back instead of after a hidden reasoning pass that
can use up `max_tokens` and leave `content` empty.

### Python (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="<pc-url>/v1", api_key=os.environ["TASKLY_AI_KEY"])

# Chat, not streamed
reply = client.chat.completions.create(
    model="qwen3.5:4b",
    messages=[{"role": "user", "content": "Summarise: ..."}],
)
print(reply.choices[0].message.content)

# Chat, streamed
stream = client.chat.completions.create(
    model="qwen3.5:4b",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")

# Transcription (Arabic or English, auto-detected)
with open("clip.mp3", "rb") as f:
    t = client.audio.transcriptions.create(
        model="whisper-1", file=f, response_format="verbose_json"
    )
print(t.text)

# Translation of audio into English
with open("clip.mp3", "rb") as f:
    en = client.audio.translations.create(model="whisper-1", file=f)
print(en.text)

# Text translation (not OpenAI: plain HTTP with the same key)
import requests
r = requests.post(
    "<pc-url>/v1/translate",
    headers={"Authorization": f"Bearer {os.environ['TASKLY_AI_KEY']}"},
    json={"text": "مرحبا بالجميع", "target": "en"},
    timeout=30,
)
print(r.json()["text"])
```

### JavaScript / TypeScript (`openai` SDK)

```ts
import OpenAI from "openai";
import fs from "node:fs";

const client = new OpenAI({
  baseURL: "<pc-url>/v1",
  apiKey: process.env.TASKLY_AI_KEY,
});

const reply = await client.chat.completions.create({
  model: "qwen3.5:4b",
  messages: [{ role: "user", content: "Summarise: ..." }],
});
console.log(reply.choices[0].message.content);

// Streamed
const stream = await client.chat.completions.create({
  model: "qwen3.5:4b",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");

// Transcription
const t = await client.audio.transcriptions.create({
  file: fs.createReadStream("clip.mp3"),
  model: "whisper-1",
  response_format: "verbose_json",
});
console.log(t.text);

// Text translation (plain fetch)
const r = await fetch("<pc-url>/v1/translate", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.TASKLY_AI_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ text: "مرحبا بالجميع", target: "en" }),
});
console.log((await r.json()).text);
```

### curl

```sh
# Chat
curl "<pc-url>/v1/chat/completions" \
  -H "Authorization: Bearer $TASKLY_AI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5:4b","messages":[{"role":"user","content":"Hello"}]}'

# Transcription
curl "<pc-url>/v1/audio/transcriptions" \
  -H "Authorization: Bearer $TASKLY_AI_KEY" \
  -F file=@clip.mp3 -F model=whisper-1

# Text translation
curl "<pc-url>/v1/translate" \
  -H "Authorization: Bearer $TASKLY_AI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"مرحبا بالجميع","target":"en"}'
```

### PHP (cPanel, cURL extension)

```php
<?php
$ch = curl_init(getenv("TASKLY_AI_URL") . "/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer " . getenv("TASKLY_AI_KEY"),
        "Content-Type: application/json",
    ],
    CURLOPT_POSTFIELDS => json_encode([
        "model" => "qwen3.5:4b",
        "messages" => [["role" => "user", "content" => "Hello"]],
    ]),
    CURLOPT_TIMEOUT => 120,
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

$data = json_decode($body, true);
echo $status === 200 ? $data["choices"][0]["message"]["content"] : $body;
```

`TASKLY_AI_URL` is the `/v1` base URL. PHP has no SDK retry, so add your own
backoff (§5).

---

## 5. Errors and fairness

**Error shape** (OpenAI routes):

```json
{"error": {"message": "invalid or missing API key", "type": "invalid_request_error", "param": null, "code": "invalid_api_key"}}
```

`param` names the field when one is at fault. `type` is `server_error` for 5xx.

| Status | When | `code` |
| --- | --- | --- |
| 400 | Missing or bad field: `model`, `messages`, `file`, `response_format`, `language`, `text`, `target`, `source`; body is not JSON | — |
| 401 | Missing or wrong key | `invalid_api_key` |
| 404 | Chat model not on the allowlist, or not installed | `model_not_found` |
| 404 | Unknown route | `not_found` |
| 411 | No `Content-Length` (chunked bodies are refused) | — |
| 413 | Body too big, audio over 2 hours, or `/v1/translate` text over 20 000 characters | — |
| 429 | The queue is full, or the request waited 40 s for a slot. Sends `Retry-After` (seconds) | `rate_limit_exceeded` |
| 500 | Internal error (`"internal error"`) | — |
| 502 | Ollama answered with an error on chat | — |
| 503 | Ollama (the language models) is down — an offered model then answers 503, retryable, not 404; no translator configured, or translation failed (`/v1/translate`, audio translations) | — |

**Ollama down.** An offered chat model answers 503 while Ollama is unreachable;
the server re-checks every few seconds, so requests work again as soon as
Ollama is back (a good model list is cached for a minute).

**Fairness.** The GPU is shared, so the server runs two queues:

- `speech`: Whisper decodes. `--stt-slots`, default 1.
- `llm`: Ollama requests, which are chat, `/v1/translate` and the translation
  step of audio translations. `--llm-slots`, default 2.

Each queue hands out slots round-robin across keys. A key runs at most
`--per-key` requests at once per queue (default 1), or its own `--concurrency`
from `serve keys add`. So parallel requests from one platform wait behind each
other. Up to `--max-queue` (default 32) requests wait per queue. A request that
is refused or waits more than 40 s gets 429 with `Retry-After`.

**Measured** (this PC, RTX 5050, 2026-10-25; two keys, real OpenAI SDK):

| Load | Transcription, 13 s Arabic clip | Chat, ~60 tokens |
| --- | --- | --- |
| One platform at a time | 1.1 s median (1.18 max) | 0.9 s median |
| Platform A transcribes while B chats | 1.9 s median (2.3 max) | 1.4 s median (1.5 max) |
| A and B both transcribe at once | A 2.06 s, B 2.04 s median — an even split | — |

Streaming chat: first token in 0.14 s. A whole 13 s file takes about as long as
its two utterances do one after another, because each utterance is its own turn
in the speech queue (so other platforms' requests slot in between).

**Retries.** Clients should wait for `Retry-After` and then back off. The
official OpenAI SDKs retry 408, 409, 429, 5xx and connection errors twice by
default. Check your SDK version. Hand-written clients, such as the PHP example,
need their own backoff.

---

## 6. Taskly itself

**(a) The meeting recorder on laptops.** A laptop sends its audio to the
server with the server's address and its key:

```powershell
.\.venv\Scripts\python.exe -m taskly_live start --meeting <id> --server http://<host>:8765 --server-key <key>
```

The same settings come from `TASKLY_MODEL_SERVER` and `TASKLY_MODEL_SERVER_KEY`.
Existing laptops use the migrated `taskly-laptops` key and need no change. A
laptop checks its key before a session starts. The recorder routes use their
own error shape, `{"error": "<message>"}`, and a busy server answers 503
`{"error": "busy"}` with `Retry-After`. Platforms should not use these routes.

**(b) Taskly's own summaries.** In **Platform → Settings → Live meetings →
Summaries**, choose **Service: OpenAI-compatible endpoint** and fill in
exactly these three fields:

| Field | Value |
| --- | --- |
| API key | A key made for Taskly: `serve keys add taskly-web` |
| Base URL | `https://<pc>.<tailnet>.ts.net`. A `/v1` tail is optional: the code adds `/v1` when it is missing |
| Model | `qwen3.5:4b`. This service has no default model, so the field is required |

Taskly uses the endpoint only when all three are set. Until then, summaries
stay on the device, which is the default. The matching environment variables
are `LIVE_SUMMARY_PROVIDER=openai_compatible`, `LIVE_SUMMARY_BASE_URL`,
`LIVE_SUMMARY_KEY` and `LIVE_SUMMARY_MODEL`.

Taskly's web app runs in the cloud, so it needs the **public** URL from §7.
It calls `POST {base}/v1/chat/completions` with `temperature: 0`, no stream
and no `max_tokens`.

Checked 2026-10-25 with that exact request shape: the server adds
`reasoning_effort: "none"` (Taskly doesn't send one), so the reply is the JSON
alone, with no reasoning text, and it parses. A full Taskly-web summary through
the public URL still needs the Funnel URL (§7) to be tried end to end.

---

## 7. Public access with Tailscale Funnel (chosen; NOT enabled yet)

The owner chose Funnel's `.ts.net` address as the public URL for the platforms
(the platforms are cloud-hosted, and zawyh.com's DNS stays in cPanel, which
rules out a Cloudflare Tunnel on a zawyh.com name). Funnel exposes the server
to the **whole internet**, so each system step below is still done only with
the owner's go-ahead at that moment.

**Steps**

1. Install Tailscale on the PC and sign in. Turn on **Run unattended**, so the
   PC stays connected with nobody signed in. The installer script's own
   message gives `tailscale set --unattended=true`. *Not checked against
   Tailscale's docs.*
2. In the Tailscale admin console:
   - enable **MagicDNS** and **HTTPS certificates**;
   - add the Funnel node attribute to the policy: **Access controls**, expand
     **Funnel**, then **Add Funnel to policy**.
   Funnel needs Tailscale v1.38.3 or later.
3. On the PC, start Funnel in the background. It proxies to the server on
   **localhost**:

   ```powershell
   tailscale funnel --bg --https=443 127.0.0.1:8765
   ```

4. The public URL is `https://<machine>.<tailnet>.ts.net`. Use
   `https://<machine>.<tailnet>.ts.net/v1` as the base URL.

**Turn it off**

```powershell
tailscale funnel --https=443 off      # add --bg too if it was started with --bg
tailscale funnel reset               # clears all Funnel configuration
```

Funnel can listen only on public ports **443, 8443 and 10000**.

Sources: <https://tailscale.com/kb/1223/funnel> and
<https://tailscale.com/docs/reference/tailscale-cli/funnel>.

**Security notes**

- Every route except `GET /v1/health` needs a key. `/v1/health` without a key
  says only `{"ok": true}` (no models, device or queues). Unknown routes answer
  404 without checking a key.
- Keys are 256 bits, so guessing one isn't practical; there's no separate
  failed-key throttle (behind Funnel every request arrives from 127.0.0.1, so a
  per-client limit would need Funnel's forwarded headers). If a key leaks,
  revoke it at once: `serve keys revoke <name>` — the running server stops
  accepting it within seconds.
- Slow or flooding clients: a connection that goes quiet for 60 s is closed,
  at most 64 connections are served at once (more get an immediate 503), bodies
  are capped (25 MB audio, 4 MB chat, 35 s recorder PCM), and the GPU queues
  answer 429 when full. The `Server` header names no Python version.
- Logs carry route, key name, status and time only — never prompts, audio,
  transcripts or translations.
- Funnel forwards to `127.0.0.1`. Keep the server's `--host` at its default
  `0.0.0.0`, or use `127.0.0.1`. An address-only bind (for example the
  `100.x` address alone) receives no Funnel traffic.
- Funnel terminates TLS. The server itself speaks plain HTTP behind it.

---

## 8. Operating it

**The 24/7 services.** `desktop-engine\scripts\install-pc-services.ps1` installs
two Windows services, run from an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-pc-services.ps1
```

- **`ollama`**: `ollama.exe serve` on 127.0.0.1:11434, with
  `OLLAMA_KEEP_ALIVE=-1` and `OLLAMA_CONTEXT_LENGTH=8192`.
  - `KEEP_ALIVE=-1` keeps the model loaded. The OpenAI endpoint cannot set a
    keep-alive per request, so each chat call would otherwise reset the
    translator to Ollama's 5-minute idle timeout.
  - `CONTEXT_LENGTH=8192` matches the server's own context size. The OpenAI
    endpoint ignores `num_ctx`, so a different size would make Ollama reload
    the model.
- **`taskly-model-server`**: `python -m taskly_live serve --require-gpu
  --translator ollama --host 0.0.0.0 --port 8765`. It starts after `ollama`.
  `--require-gpu` makes the server exit (code 3) when Whisper is not on CUDA.
  The service then restarts it: after 10 s, then 30 s, then every 60 s, until
  CUDA is ready.

Both services run as LocalSystem with delayed auto-start, so nobody needs to
sign in. They restart on failure. The installer also:

- asks yes or no before each step, and shows its plan first;
- downloads WinSW v2.12.0 and checks its SHA-256 before use;
- adds an inbound firewall rule for TCP 8765 on the Private profile;
- stops the Ollama tray app from starting at sign-in (backed up);
- sets the PC to never sleep on AC power, and offers to turn hibernation off;
- checks, and never changes, Tailscale's "Run unattended" setting.

Re-running it is safe. Models, keys and data are not touched.

**Logs.** `C:\ProgramData\TasklyAI\ollama\logs\` and
`C:\ProgramData\TasklyAI\taskly-model-server\logs\`. Each service writes
`<id>.out.log`, `<id>.err.log` and `<id>.wrapper.log`, rolled at 10 MB with 8
files kept.

**Check health from outside.** Call it with a key, from anywhere on the tailnet
or over Funnel:

```sh
curl -H "Authorization: Bearer $TASKLY_AI_KEY" "<pc-url>/v1/health"
```

A keyed reply includes `"device": "cuda"` when the GPU works. It also shows the
Whisper model, the translator, the summarizer, the chat models and the queues.
Each queue reports `slots`, `free`, `running` and `waiting`. Without a key, the
reply is only `{"ok": true}`. A wrong key gets 401 with `{"error": "unauthorized"}`.

**Reboot test (not yet run).** Restart the PC and do not sign in. From a
laptop, `GET /v1/health` should answer within a few minutes. Tailscale must
have "Run unattended" on for the tailnet path to come up.

**Uninstall.** `desktop-engine\scripts\uninstall-pc-services.ps1` (not reviewed
for this page).
