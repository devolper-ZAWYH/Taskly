# Taskly Live — capture engine (Python prototype)

Capture engine for **Taskly Live Meetings** (plan §3 engine box, Phase 2 MVP).
It runs on the meeting laptop (Windows, macOS or Linux). It captures the
laptop's microphone **and** the meeting app's audio (system loopback), cuts
each source into utterances (VAD), turns every utterance into text, and pushes
**text-only** segments to Taskly over the `/api/live/*` device-token API. Each
line reaches Taskly in both app languages (`text_en` and `text_ar`). When a
recording linked to a meeting ends, the engine writes the meeting's **review
draft** (summary, decisions, follow-ups, action items) with a local model and
posts it for the recorder's review card.

The speech work runs in one of two places:

- **On the laptop** (default): faster-whisper and, optionally, Ollama for
  translation, all on this machine.
- **On a GPU PC** (`--server`): the laptop sends each utterance's audio to the
  PC's **model server** (`python -m taskly_live serve`, §6), which returns the
  text, the translation and the summary. The PC holds no meeting state and never
  sees a Taskly token.

Audio leaves the laptop only in the second mode, and only to the model server
you name. Taskly itself never receives audio.

The same PC also serves other platforms through an OpenAI-compatible API (chat,
transcription, translation), each with its own key. See [CONNECT.md](CONNECT.md).

> This is the explicitly allowed **Python dev fallback** path against the
> same API contract; the production engine (Rust + whisper.cpp embedded in
> Tauri) is expected to follow later.

---

## 1. Layout

```
desktop-engine/
├── pyproject.toml           PEP 621 (package + test extras)
├── requirements.txt         pinned deps: the GPU PC and laptops that decode locally
├── requirements-laptop.txt  pinned deps: a laptop that uses a model server
├── .gitignore               .venv/, models/, journal.sqlite3, server-keys.json, model-server.key, state files
├── fixtures/                generated speech clips for replay tests
│   ├── clip-en2.mp3         English neural TTS (edge-tts)
│   ├── clip-ar.mp3          Arabic neural TTS (edge-tts)
│   └── clip-en.wav          English Windows SAPI voice (robotic; hardest case)
├── taskly_live/
│   ├── cli.py               commands: start / stop / status / replay / summarize /
│   │                        serve / test / mockserve
│   ├── config.py            env (TASKLY_*) + CLI overrides; model-server settings
│   ├── server.py            `serve`: the GPU PC's shared model server (HTTP, platform keys)
│   ├── openai_api.py        its OpenAI-compatible routes (CONNECT.md)
│   ├── openai_io.py         multipart, audio decoding, OpenAI error/response shapes
│   ├── keys.py              per-platform API keys (hashed) + usage counters
│   ├── scheduler.py         fair GPU queues: round-robin per key, 429 when full
│   ├── remote.py            laptop side of the model server: RemoteStt (retries
│   │                        each utterance for 5 min), RemoteSummarizer
│   ├── gpu.py               Windows: adds the venv's nvidia/*/bin folders (cuBLAS, cuDNN)
│   ├── translate.py         Arabic <-> English per line (Ollama); a failed
│   │                        translation never drops the line
│   ├── summarize.py         on-device review draft: prompt (port of the server's),
│   │                        Ollama JSON-schema call, defensive parse + caps
│   ├── api.py               /api/live contract client (text-only payloads)
│   ├── audio.py             mic (sounddevice) + system audio per OS (WASAPI loopback,
│   │                        BlackHole, parec), gain guard + clipping detection,
│   │                        resample → 16 kHz
│   ├── vad.py               webrtcvad adapter + energy VAD (Py3.13 default),
│   │                        gap 700 ms / hangover 600 ms state machine
│   ├── stt.py               faster-whisper: transcribe (auto-lang); the translate pass
│   │                        only when no translator runs; GPU detect-with-fallback;
│   │                        hallucination filter
│   ├── journal.py           SQLite append-before-send journal (WAL, sync=FULL)
│   ├── pusher.py            batched idempotent pusher (≤200, coalesce 3 s,
│   │                        backoff 1→5→30→120 s cap ± jitter, crash replay)
│   ├── recorder.py          live orchestration (sources→VAD→STT→journal→push)
│   ├── replay.py            --replay mode for CI/testing (no capture devices)
│   ├── mock_server.py       TEST-ONLY stdlib mock of the Taskly contract
│   ├── stream.py            SUPERSEDED by server.py/remote.py: the LAN WebSocket
│   ├── protocol.py          `serve`/`capture` bridge (v0.2) and its wire format and
│   └── spill.py             disk spill. No command uses them; kept for reference only
└── tests/                   pytest: VAD gap logic, journal FSM, pusher idempotent
                             replay ordering, contract round-trip, summary prompt/parse/
                             Ollama request/draft post, model server + remote client,
                             translation, per-OS audio source selection
```

Runtime files (in this folder, gitignored): `journal.sqlite3` (+WAL),
`models/` (Whisper weights cache), `engine-state.json`, `engine.stop.flag`,
and on the GPU PC `server-keys.json` (platform keys, stored as hashes) plus the
older `model-server.key` (imported once as the key `taskly-laptops`).

## 2. Setup

Requires Python **≥3.11**; verified on **3.13.15** (see Known issues for the
webrtcvad note).

### 2.1 Meeting laptop (uses the GPU PC)

Nothing is decoded here, so the laptop needs only the capture stack.

Windows (PowerShell):

```powershell
cd "C:\Users\Thouseef Purayil\Desktop\Taskly\desktop-engine"
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-laptop.txt
```

macOS / Linux:

```sh
cd desktop-engine
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements-laptop.txt
```

`requirements-laptop.txt` installs numpy, requests, sounddevice, and
PyAudioWPatch (Windows only). It has no faster-whisper, CTranslate2 or CUDA.

Start a recording against the PC (§4 has the full command list):

```powershell
$env:TASKLY_URL          = "https://<your Taskly address>"   # default http://localhost:3100
$env:TASKLY_TOKEN        = "<device token>"                   # Settings -> Live capture
$env:TASKLY_MODEL_SERVER = "http://<pc>:8765"                 # the PC's address (§2.3)
$env:TASKLY_MODEL_SERVER_KEY = "<server key>"                 # printed by `serve`
.\.venv\Scripts\python.exe -m taskly_live start --meeting <meeting id>
```

```sh
export TASKLY_URL=https://<your Taskly address>
export TASKLY_TOKEN=<device token>
export TASKLY_MODEL_SERVER=http://<pc>:8765
export TASKLY_MODEL_SERVER_KEY=<server key>
./.venv/bin/python -m taskly_live start --meeting <meeting id>
```

The same settings can be given as flags: `start --url … --token … --server
http://<pc>:8765 --server-key <key> --meeting <id>`. A laptop with `--server`
checks the key with the PC before the session starts; a wrong key stops it there.

**System audio, per OS.** The microphone works the same everywhere
(`--device` / `TASKLY_DEVICE` picks one). The meeting's audio is taken from
the system, as follows:

- **Windows**: WASAPI loopback of the default output device. Nothing to
  install (PyAudioWPatch comes from `requirements-laptop.txt`). It captures
  what the meeting app plays, whatever headphones or speakers are in use.
- **macOS**: CoreAudio cannot tap the output, so route it through BlackHole.
  1. `brew install blackhole-2ch` (or BlackHole 2ch from existential.audio).
  2. In **Audio MIDI Setup**, create a **Multi-Output Device** with your speakers
     or headphones plus **BlackHole 2ch**, and set it as the system output (so
     you still hear the meeting).
  3. Grant the terminal app microphone permission (System Settings → Privacy &
     Security → Microphone).

  The engine finds the input device whose name contains "BlackHole".
- **Linux**: PulseAudio, or PipeWire with its Pulse layer. Install the tools
  with `sudo apt install pulseaudio-utils libportaudio2`. The engine runs
  `parec` on `@DEFAULT_MONITOR@` (the default output's monitor). If `parec` is
  missing or exits at once, it falls back to a sounddevice input whose name
  contains "monitor".

On every OS, `--system-device` / `TASKLY_SYSTEM_DEVICE` picks another source:
an index or a name substring (run `python -m sounddevice` to list inputs). On
Linux a Pulse source name from `pactl list short sources` also works. An
explicit device never falls back to a different one.

### 2.2 The GPU PC (model server)

Windows 11, PowerShell, with an NVIDIA GPU:

```powershell
cd "C:\Users\Thouseef Purayil\Desktop\Taskly\desktop-engine"
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
```

(cuBLAS is the one CTranslate2 4.8 strictly needs; cuDNN is optional since
4.6 and was installed alongside on the verified PC.)

- **CUDA runtime**: the last line installs the CUDA 12 runtime into the venv
  only, so no system-wide CUDA toolkit is needed. Without it, every GPU decode
  fails with "cublas64_12.dll not found" and the server falls back to the CPU.
  At startup `gpu.py` adds those DLL folders to the Windows DLL search path.
  Verified on an RTX 5050 (Blackwell, sm_120): the wheel has no sm_120
  kernels, so the driver JIT-compiles them on the very first decode after an
  install (seconds, once; cached afterwards), and `serve` warms both models up
  at startup.
- **Ollama**: install [Ollama](https://ollama.com) and pull the model once with
  `ollama pull qwen3.5:4b`. That one model translates every line and writes the
  summaries (§5); `serve` warms it up at start (~8 s cold) and keeps it loaded.
  Optional alternative translator: `ollama pull hf.co/tencent/Hy-MT2-1.8B-GGUF:Q8_0`.
- **NVIDIA setting (recommended)**: NVIDIA Control Panel → Manage 3D settings →
  Program Settings → add `python.exe` (the venv's) and `ollama.exe` → "CUDA –
  Sysmem Fallback Policy" = "Prefer No Sysmem Fallback". Otherwise a full card
  quietly spills into system RAM and every line slows down instead of failing.
- **Start it**:

  ```powershell
  .\.venv\Scripts\python.exe -m taskly_live serve
  ```

  The first run downloads the Whisper model (`large-v3-turbo` by default) from
  Hugging Face into `desktop-engine\models`; after that it works offline. The
  banner shows the model, the device it loaded on, the translator and the
  summarizer, the keys by name and the URLs to connect with (§6). It prints a key
  only when none exists yet (it then makes one named `default`); make one per
  platform with `serve keys add <name>` (CONNECT.md).

Options: `--host` (default `0.0.0.0`, all interfaces; set it to the PC's
Tailscale or LAN address to narrow the listener), `--port` (default `8765`),
`--stt-slots` (speech decodes at once, default 1), `--llm-slots` (Ollama requests
at once, default 2), `--per-key` (per key per queue, default 1), `--max-queue`
(waiting before 429, default 32), `--chat-models` (Ollama models offered to
platforms, default the summary model), `--require-gpu` (exit 3 without CUDA),
`--wait-ollama` (seconds, default 120), `--model` / `TASKLY_MODEL` (Whisper model),
`--translator` / `TASKLY_TRANSLATOR` (default `auto` on `serve`),
`--translate-model`, `--ollama-url`, `--summary-model`, `--data-dir`.

### 2.3 Network: Tailscale or LAN

**Tailscale is recommended**, for the same network and for remote laptops.
Install it on the PC and on every laptop, sign them in to one tailnet, and use
the PC's `100.x` address (`tailscale ip -4` prints it). Traffic between them is
WireGuard-encrypted. The server's setup lines list the Tailscale address first
when the `tailscale` command is on the PATH.

A plain LAN works too, with the PC's LAN address. The server speaks plain HTTP
only, so on a LAN the audio and the key cross the network unencrypted. Use
Tailscale when that matters.

Allow inbound TCP 8765 on the PC once, in an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Taskly model server" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow -Profile Private
```

Tailscale's adapter can be classed as Public rather than Private. If laptops
time out over Tailscale while the LAN works, check with `Get-NetConnectionProfile`
and allow the matching profile.

### 2.4 Start the model server at log on (Windows)

For a PC that must serve models around the clock, the service installer in §2.5
supersedes this section. It runs the model server as a Windows service that
starts at boot, without a sign-in. The Task Scheduler steps below still work
for a PC that signs in and stays on.

Ollama installs its own startup entry, so check that it runs too.

**Task Scheduler**: Create Task → Trigger **At log on** → Action **Start a
program**: Program `<repo>\desktop-engine\.venv\Scripts\python.exe`, Arguments
`-m taskly_live serve`, **Start in** `<repo>\desktop-engine`.

**Or from Command Prompt (cmd)** — Task Scheduler has no "Start in" on this
command line, so it changes folder first:

```bat
schtasks /Create /SC ONLOGON /TN "Taskly model server" /TR "cmd /c \"cd /d \"C:\Users\Thouseef Purayil\Desktop\Taskly\desktop-engine\" && \"C:\Users\Thouseef Purayil\Desktop\Taskly\desktop-engine\.venv\Scripts\python.exe\" -m taskly_live serve\""
```

Start it now with `schtasks /Run /TN "Taskly model server"`, and remove it with
`schtasks /Delete /TN "Taskly model server" /F`. The task runs in a console
window; give the laptops a key from `serve keys add <name>` (or the migrated
`taskly-laptops` key in `desktop-engine\model-server.key`).

### 2.5 24/7 service (Windows)

The service installer, `scripts\install-pc-services.ps1`, sets up two Windows
services: `ollama` and `taskly-model-server`. Both start at boot without a
sign-in and restart on failure. Run it once from an elevated PowerShell, in
`desktop-engine`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-pc-services.ps1
```

It asks yes or no before each step, and nothing changes until you approve.
When it finishes it reports whether the GPU is in use from the service.

- Check the services: `Get-Service ollama, taskly-model-server`.
- Logs: `C:\ProgramData\TasklyAI\<service>\logs\`.
- Remove everything: `scripts\uninstall-pc-services.ps1`.

Details, including the health check and the reboot test: [CONNECT.md §8](CONNECT.md).

## 3. Configuration (env or CLI)

Anything the CLI passes overrides the environment. Every knob has a safe
default, so `python -m taskly_live test` works with no configuration.

| Env | CLI flag | Meaning |
| --- | --- | --- |
| `TASKLY_URL` | `--url` | Taskly base URL (default `http://localhost:3100`) |
| `TASKLY_TOKEN` | `--token` | device token — Settings → Live capture (raw token) |
| `TASKLY_MODEL` | `--model` | Whisper model: `small` on a laptop, `large-v3-turbo` for `serve` |
| `TASKLY_DEVICE` | `--device` | mic index/name substring; default system mic |
| `TASKLY_SYSTEM_DEVICE` | `--system-device` | system-audio device override (§2.1) |
| `TASKLY_MODEL_SERVER` | `--server` | the PC's model server, e.g. `http://100.x.y.z:8765` (port 8765 if omitted); set = nothing is decoded on this machine |
| `TASKLY_MODEL_SERVER_KEY` | `--server-key` | that server's key (`serve` prints it; also in `model-server.key`) |
| `TASKLY_TRANSLATOR` | `--translator` | `off` \| `ollama` \| `hymt` \| `marian` \| `auto` (§5); laptop default `off`, `serve` default `auto` |
| `TASKLY_TRANSLATE_MODEL` | `--translate-model` | Ollama model for `--translator ollama` (default `qwen3.5:4b`) |
| `TASKLY_OLLAMA_URL` | `--ollama-url` | local Ollama (default `http://127.0.0.1:11434` — not `localhost`, which costs ~2 s a request on Windows) |
| `TASKLY_SUMMARY_MODEL` | `--summary-model` | Ollama model that writes the review draft (default `qwen3.5:4b`) |
| `TASKLY_SUMMARY=0` | `--no-summary` | don't write the draft when a recording ends |
| `TASKLY_LANGUAGE` | `--language` | force `ar` or `en`; default auto |
| `TASKLY_GAP_MS` | `--gap-ms` | VAD gap (default `700`) |
| `TASKLY_DATA_DIR` | `--data-dir` | journal, `models/` and `model-server.key` (default: this folder) |

Extras: `--meeting <id>` (the Taskly meeting this records — the `?meeting=`
value in the app's URL; without it the recording is a private rehearsal with
no review card), `--no-mic` / `--no-system`, `--no-auto-gain`, `--verbose`.
The token is sent as `Authorization: Bearer <token>`; the server stores
only its SHA-256.

## 4. Commands (`python -m taskly_live ...`)

```powershell
# live capture to your real Taskly (server agent should be running on :3100),
# into a meeting so it gets a review card; the draft is written when it ends
.\.venv\Scripts\python.exe -m taskly_live start --meeting m-11

# laptop: capture now, decode on the GPU PC
.\.venv\Scripts\python.exe -m taskly_live start --meeting m-11 --server http://100.x.y.z:8765 --server-key <key>

# GPU PC: the model server for laptops (§2.2, §6); holds no meeting state
.\.venv\Scripts\python.exe -m taskly_live serve

# (re)write an ended session's review draft and post it
# (--dry-run prints it instead); a new one replaces the old
.\.venv\Scripts\python.exe -m taskly_live summarize <sessionId>

# stop the running engine (end session -> 'reviewing')
.\.venv\Scripts\python.exe -m taskly_live stop

# inspect the engine + journal
.\.venv\Scripts\python.exe -m taskly_live status

# offline: transcribe a local file through the identical pipeline & push
.\.venv\Scripts\python.exe -m taskly_live replay fixture.wav --speed 1
#   --speed x = faster-than-realtime pacing (CI); only the wav is read locally
#   non-WAV files need PyAV (`pip install av`); plain PCM WAV reads without it

# offline dev/test everything without any Taskly server:
.\.venv\Scripts\python.exe -m taskly_live test      # contract round-trip vs mock
.\.venv\Scripts\python.exe -m taskly_live start --mock          # mock in-process
.\.venv\Scripts\python.exe -m taskly_live replay clip.wav --mock
.\.venv\Scripts\python.exe -m taskly_live mockserve            # standalone mock
# or run pytest
.\.venv\Scripts\python.exe -m pytest
```

### On-device review draft (Ollama)

Install [Ollama](https://ollama.com), then pull the model once:
`ollama pull qwen3.5:4b` (any model works via `--summary-model`). After a
recording linked to a meeting ends, `start` and `replay` ask Ollama for the
minutes using the same prompt Taskly's server-side providers use, and post
them as the session's draft. That Ollama is the laptop's own, or the GPU PC's
when the engine uses `--server` (the laptop then sends the prompt to the PC and
posts the answer). The prompt holds the numbered transcript lines and nothing
else: no meeting title, no session id. The engine then waits up to 7 days on the
meeting's **Review summary** card. A missing Ollama, an unreachable PC or a bad
reply never fails the recording: the transcript is already in Taskly, and the
console says how to retry (`summarize <sessionId>`). On this dev box,
`qwen3.5:4b` wrote a two-line meeting's draft in 3–12 s. The draft can only be as
good as the transcript; with Whisper `small`, Arabic lines are often
mistranslated.

During `start`: **Ctrl-C** ends the session gracefully (flush → final push →
end → review draft). A second operator can also run `taskly_live stop` from another
console (flag-file handshake).

Crash recovery: everything is appended to the journal **before** the first
push. Restart with `start --resume <sessionId>` to replay any un-acked rows;
duplicates are ignored by the server (`UNIQUE(session_id, seq)`).

## 5. Translation (Arabic ↔ English)

Every line reaches Taskly in both app languages. The spoken line fills its own
slot (`text` for the language it was spoken in, plus `lang`). The other slot
comes from a translator, chosen with `--translator` / `TASKLY_TRANSLATOR`:

| Value | What it does |
| --- | --- |
| `off` | No translator. Whisper's own translate pass gives `text_en` for non-English lines. Whisper translates only into English (and turbo not at all), so `text_ar` is set only for lines spoken in Arabic. |
| `ollama` | An Ollama chat model (`--translate-model`, default `qwen3.5:4b`) translates each line. ~0.3 s a line; the only one that kept the meaning of dialect and Arabic/English-mixed lines in tests. On `serve`, when it's also the summary model, it stays loaded for good. |
| `hymt` | Tencent Hy-MT2-1.8B (Apache-2.0) in Ollama, prompted raw (Ollama 0.40 builds a broken chat template for it). ~0.2 s a line, fine on clean lines, but it changed the meaning of dialect lines in tests (below). |
| `marian` | Helsinki-NLP opus-mt-tc-big on CTranslate2 beside Whisper, no Ollama needed. ~0.05 s a line, the weakest on dialect. Weights (~480 MB a direction) download once into `models/`. |
| `auto` | The first that works: `ollama` (model pulled), then `hymt` (pulled), then `marian` (loads), then `off` with a warning. Decided once at startup. |

With any translator Whisper's translate pass is skipped. Ollama translators
fail fast, because they run inside the server's GPU slot: a 10 s timeout, then
30 s in which lines go out untranslated rather than queue behind (say) a long
summary holding Ollama. Before a summary, `serve` unloads an Ollama translator
that isn't the summary model itself, so both never crowd the card together.

Defaults: a laptop uses `off`; `serve` uses `auto`. The startup banner's
`translator :` line shows what the PC picked. With `--server`, translation runs
on the PC, so the laptop's own `--translator` has no effect.

A translation is never a gate. If the translator fails or is slow, the line is
sent without that translation, so a dead translator never drops speech.

Taskly shows each reader their own language first. An Arabic reader gets
`text_ar` on top, and an English reader gets `text_en`. The spoken line sits
underneath when it is in the other language.

## 6. Model server (`serve`, the GPU PC)

The model server is the GPU PC's HTTP service for laptops. It owns the Whisper
model, the translator and the Ollama summaries. Each laptop keeps its own
pipeline and its own Taskly token, and sends the server only utterance audio
or a summary prompt.

| Route | Request | Answer |
| --- | --- | --- |
| `GET /v1/health` | none (no key needed) | `200 {"ok": true}`. With the right key, also the model, device, translator and summarizer. With a wrong key: `401`. |
| `POST /v1/transcribe` | `application/octet-stream`: int16 little-endian mono 16 kHz PCM, at most 35 s, with the key | `200 {"text", "lang", "text_en", "text_ar", "transcribe_s", "translate_s"}`, or `{"text": null}` for silence or a filtered hallucination |
| `POST /v1/complete` | JSON `{"system": "...", "user": "..."}` (both non-empty), with the key | `200 {"content": "..."}` from the local Ollama |

Every route but health needs `Authorization: Bearer <server key>`. Other errors:
`400` (bad body or odd PCM length), `401` (no or wrong key), `411`/`413` (no
length or body too large), `502` (Ollama refused the summary), `503` (busy or
no summarizer), `500` (the model failed), `404` (unknown route).

**Keys.** One per platform: `serve keys add <name>` prints it once, `serve keys
list` shows last use and usage, `serve keys revoke <name>` retires it (the
running server picks both up within seconds). Stored as SHA-256 hashes in
`<data dir>\server-keys.json`; the older single `model-server.key` was imported
as `taskly-laptops`, so existing laptops keep working. Treat keys like
passwords. Both files are gitignored.

**GPU work.** Two fair queues (scheduler.py): "speech" (Whisper and the line
translator, `--stt-slots`, default 1) and "llm" (Ollama, `--llm-slots`, default
2), each round-robin across keys with `--per-key` running per key. A request
that can't get a slot within 40 s, or finds the queue full, gets `503` +
`Retry-After` on these routes (the laptop retries) and `429` + `Retry-After` on
the OpenAI routes. Measured with two platforms at once: see CONNECT.md.

**What the PC knows.** It gets audio or a summary prompt and the server key. It
never gets a Taskly token, a session id or a meeting id, and it keeps no sessions
or transcripts. It logs routes, statuses, sizes and timings only, never the
words.

**Outages.** A laptop retries each utterance with backoff (0.5 s, doubling up to
30 s) for up to **5 minutes**, and the recorder waits for the answer (about 6½
minutes at most). So a PC reboot or a laptop that loses Wi-Fi briefly loses no
speech: the lines journal and push in order once the link is back. Only a wrong
key, or audio the server refuses (`400`/`413`), fails at once, because retrying
those would never help. A wrong key stops `start` before the session begins. An
unreachable server only warns, so a PC still booting is fine.

For the summary, the laptop tries three times before giving up. The recording
still ends, and `summarize <sessionId>` retries later.

## Models and measured latency

What `serve` runs. Chosen 2026-10-25 against the Hugging Face options in two
research passes (both reports in the session notes) and then measured on this
PC; where the measurements disagreed with a report, the measurements won:

| Job | Model | Runtime | Licence |
| --- | --- | --- | --- |
| Speech → text (ar/en, auto-detected) | `large-v3-turbo` (`mobiuslabsgmbh/faster-whisper-large-v3-turbo`) | faster-whisper / CTranslate2, CUDA `int8_float16` | MIT |
| Translation ar ↔ en, and the summary | `qwen3.5:4b` | Ollama, kept loaded | per Ollama's model page |
| Alternatives (`--translator`) | Hy-MT2-1.8B Q8_0 (`hymt`); opus-mt-tc-big ar-en / en-ar (`marian`) | Ollama; CTranslate2 + sentencepiece | Apache-2.0; CC-BY-4.0 |

Left out: NLLB-200, SeamlessM4T, Aya (non-commercial licences), HY-MT1.5
(licence excludes the EU, UK and South Korea), MADLAD-400 (research use),
distil-whisper (English-only), `medium` (clearly worse Arabic), 7–8 B MT
models (don't fit beside Whisper). Turbo can't do Whisper's translate task at
all, which is why a translator is needed.

**Per line, warm, through the model server** (RTX 5050 8 GB; the engine's own
Segmenter; `fixtures/clip-ar.mp3` and `clip-en2.mp3`):

| Setup | Arabic line | English line |
| --- | --- | --- |
| Before: CPU `small` int8, Whisper translate | 6.3 s (4.8 / 7.9) | 3.2 s (3.9 / 2.4) |
| **GPU turbo + qwen3.5:4b (default)** | **0.8–0.9 s** (0.5 STT + 0.3–0.4 MT) | **0.75–1.2 s** (0.5 + 0.3) |
| GPU turbo + Hy-MT2 | 0.7–0.8 s (MT 0.13–0.18) | 0.7–0.8 s (MT 0.2–0.3) |
| GPU turbo + Marian | 0.6 s (MT 0.06) | 0.5 s (MT 0.04) |

Earlier "~2.5 s per qwen line" figures were the `localhost` stall: Windows
tries IPv6 first and Ollama listens on IPv4, 2.04 s vs 0.002 s per request
from Python. The defaults now say `127.0.0.1`.

**Quality** — speech: turbo hears "سنرسل التقرير النهائي" where `small` heard
"سنلسل التقرير النهائية" (both still mishear "المهام" as "المهم"). Arabic →
English on that line, before: "Welcome to the social media platform for the
week."; now: "Hello, the meeting results for the week are ready."

Translators on harder lines (a spot check of 6, not a benchmark):

| Line | qwen3.5:4b | Hy-MT2 | Marian |
| --- | --- | --- | --- |
| شو رايك نأجل الاجتماع لين الأسبوع الجاي؟ | "What do you think about postponing the meeting to next week?" ✓ | "Why do you want to postpone the meeting…" ✗ | "…postpone the meeting?" (drops the week) |
| خلونا نسوي الـ deployment بعد الـ code review يوم الأحد | "Let's do the deployment after the code review on Sunday." ✓ | "Let's **skip** the deployment…" ✗ | "We decided to go after the code review…" ✗ |
| لين باچر بنخلص التقرير إن شاء الله | "Lin Baker will finish the report soon." ✗ | "Lynn Bachar would like to conclude…" ✗ | garbage ✗ |
| The API latency spiked … so we rolled back the migration. | ok, one non-word ("زمنانية") | "transfer duration…cancelled the transfer" ✗ | best ("زمن وصول… تراجعنا عن الهجرة") |
| Can you loop in the finance team … | "إشراك فريق المالية" ✓ | "استدعاء" (summon) ~ | "الاتصال" ~ |

Hy-MT2 failed the same way with its own model-card prompt and recommended
sampling, so it isn't the default despite its speed. None of the three gets
"لين باچر" (until tomorrow) right. Mixed-dialect evidence is thin either way:
check real meeting audio before relying on a translation for decisions.

**VRAM** (measured): Windows ~2.2 GB; `serve` with turbo adds ~0.9 GB; qwen
3.1 GB, kept loaded → ~6.3 GB of 8.1. Hy-MT2 instead of qwen adds 2.0 GB and is
unloaded before each summary.

## 7. Verified (actual output on this dev box)

2026-10-25, the GPU PC (Windows 11, RTX 5050), model server architecture:

* `python -m pytest` → **227 passed, 1 skipped** (skip = webrtcvad-only test);
  covers the model server (auth, 401/400/413/503, GPU slots), `RemoteStt`
  retries and the 5-minute window, the translators, `text_ar` through the
  journal/pusher/mock, and the per-OS capture selection (faked devices).
* `python -m taskly_live test` → **10/10 checks passed** (create → batch push →
  duplicate push ignored → 429 retry ladders → fatal 401 → requeue → end).
* End to end on one PC: `serve` (turbo on CUDA, qwen3.5:4b translating and
  summarizing; cold warm-up 7.6 s at start), then the laptop path with its
  own data dir: `replay fixtures/clip-ar.mp3 --meeting m-5 --server
  http://127.0.0.1:8765 --server-key …` → both lines acked with `text_en` and
  `text_ar` (0.8–0.9 s a line), review draft written in 1 s and shown on m-5's
  Review summary card; `clip-en2.mp3` likewise (English lines got their
  Arabic, 0.75–1.2 s). Also run with Marian and with Ollama as translator.
  Shown in Taskly in English and Arabic UI.
* A translator that fails (here: Ollama refusing a bad `keep_alive`) left the
  lines untranslated but delivered — the "never drop a line" path, observed.
* Outage: `serve` stopped, a replay started, `serve` restarted ~40 s later →
  the laptop retried (0.5 → 15 s backoff), then delivered every line.
  Nothing lost.
* Latency and quality before/after: see "Models and measured latency".
* Capture: Windows WASAPI loopback opened on real devices (default output
  and a named one via `--system-device`). macOS (BlackHole) and Linux
  (`parec`) are covered only by tests with faked devices: **not run on a real
  Mac or Linux box**.

## 8. Known issues / environment notes

* **webrtcvad has no Py3.13 wheel** (needs MSVC C++ 14 to build). The engine
  ships with an energy VAD + adaptive noise floor as the default backend and
  keeps the webrtcvad adapter in code — if a C++ toolchain is present,
  `pip install webrtcvad` activates it automatically (no other change).
* **CUDA probed, then fallback**: ctranslate2 reports CUDA devices even
  without cuBLAS; the engine attempts `cuda/int8_float16` but validates with
  a warm-up decode and falls back to `cpu/int8`. With the venv's NVIDIA
  wheels (§2.2) this box runs `cuda/int8_float16`; without them, `cpu/int8`.
* **Mic in dev VMs**: this box exposes no input device; `start` runs with
  the system loopback alone (mic+loopback concur on real machines).
* Toolchain fallback ladder (spec): faster-whisper wheels for Py3.13 exist
  (`ctranslate2 4.8.3`) — ladder (b/c) not needed. If a future Python breaks
  them, use `uv venv -p 3.12` then install as usual (documented ladder (a)).
* `fixtures/clip-en.wav` (SAPI "David") is robotic; whisper-small hears it
  as foreign speech. `clip-en2.mp3`/`clip-ar.mp3` (edge-tts, neural) are the
  reference clips used for the numbers above.

## 9. Testing

`tests/`: VAD gap/hangover/onset logic over synthetic level arrays; journal
state machine (seq assignment, ack/failed/requeue, reopen persistence);
pusher ordering/dedupe/retry with the mock server (incl. crash replay);
contract round-trip (auth, 404, 400, >200 guard, 429 semantics); the model
server's routes and the laptop's remote client (key checks, retries, the
503 path); translation; and per-OS system-audio source selection.

Run: `.\.venv\Scripts\python.exe -m pytest` (uses ephemeral local mock ports;
no real server, no audio devices needed).

## 10. Privacy / scope notes

* **Audio** leaves a laptop only with `--server`, and then only to that PC's
  model server. Taskly receives text only. No audio is written to disk by the
  pipeline (replay reads a local file only).
* **The GPU PC** holds no meeting state: no sessions, Taskly tokens or meeting
  ids. Its logs carry routes, statuses, sizes and timings, never the words.
* **Platform keys** are passwords for the PC's models. `server-keys.json` keeps
  only their hashes; both it and `model-server.key` are gitignored.
* **Model weights** download once from Hugging Face into `desktop-engine/models`;
  after that everything runs offline.
* The mock server (`mock_server.py`, `--mock`, `test`, `mockserve`) is
  **test-only**: accepts any bearer token, keeps state in memory (optionally
  a JSON file), and must never be used for real meetings.
