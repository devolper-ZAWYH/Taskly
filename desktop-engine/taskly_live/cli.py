"""Taskly Live engine CLI: `python -m taskly_live {start,stop,status,replay,test,...}`.

Commands
    start    capture mic + system loopback -> VAD -> whisper (AR/EN auto,
             EN line) -> journal -> push; Ctrl-C or `stop` ends the session
    stop     signal a running engine to end its session (flag-file handshake)
    status   show engine/journal state (state file + SQLite counts)
    replay   transcribe a local WAVOffline and deliver to the API with pacing
    summarize  (re)write a session's review draft with local Ollama and post
             it (start/replay do this on their own when the session ends)
    serve    (the GPU PC) model server for laptops: transcribe + translate
             + summarize over HTTP with a server key; holds no meeting state
    test     full contract round-trip against a built-in mock server
             (TEST-ONLY mock: never point real meetings at it)
    mockserve  run the test-only mock server standalone for offline dev

Global options after the subcommand; environment (TASKLY_URL/TOKEN/MODEL/
DEVICE, TASKLY_MODEL_SERVER/_KEY) provides defaults. With --server a laptop
keeps capture, journal and push here and sends only audio to the PC. `--mock` redirects start/replay at an in-process
mock so the flow can be exercised without the backend.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import date as _date
from pathlib import Path

from .api import LiveClient
from .config import DEFAULT_URL, Config, MAX_BATCH
from .journal import Journal

log = logging.getLogger("taskly_live")

MOCK_PORT = 3199
MOCK_TOKEN = "mock-engine-token"
MOCK_URL = f"http://127.0.0.1:{MOCK_PORT}"


# ---------------------------------------------------------------------------
# shared wiring helpers
# ---------------------------------------------------------------------------
def _install_logging(verbose: bool) -> None:
    # Windows consoles default to a legacy codepage; force UTF-8 so Arabic
    # transcript text survives printing (errors=replace as a safety net).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # pragma: no cover - exotic
            pass
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    for noisy in ("httpx", "httpx2", "huggingface_hub", "hf_xet", "faster_whisper",
                  "urllib3", "asyncio", "aiohttp"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _maybe_mock(cfg, mock: bool) -> LiveClient:
    """With --mock: spawn the TEST-ONLY server in-process and point there."""
    if not mock:
        return LiveClient(cfg.url, cfg.token, batch_limit=cfg.batch_limit)
    from .mock_server import MockServer

    server = MockServer.with_ephemeral()
    log.warning(
        "TEST-ONLY mock server running (engine runs against it, not Taskly). "
        "No real data is sent: %s",
        server.url,
    )
    return LiveClient(server.url, MOCK_TOKEN, batch_limit=cfg.batch_limit)


def _build_stt(cfg: Config, *, default_translator: str = "off", keep_looking: bool = False):
    """The PC's model server when one is configured, else local Whisper.

    Local decoding imports faster-whisper only here, so a laptop that uses
    a server never needs it (requirements-laptop.txt).
    """
    if cfg.server:
        from .remote import RemoteStt

        stt = RemoteStt(cfg.server, cfg.server_key)
        health = stt.probe()  # a wrong key stops here, before any session
        if health is not None:
            log.info("model server %s: stt=%s translator=%s", stt.url,
                     health.get("stt"), health.get("translator"))
        return stt
    from .stt import SttPipeline
    from .translate import AutoTranslator, build_translator

    kind = cfg.translator or default_translator
    if kind == "auto" and keep_looking:
        # A server runs for weeks: keep re-checking until the first choice is up.
        translator = AutoTranslator(cfg.ollama_url, cfg.translate_model, cfg.models_dir)
    else:
        translator = build_translator(kind, ollama_url=cfg.ollama_url,
                                      ollama_model=cfg.translate_model,
                                      models_dir=cfg.models_dir)
    return SttPipeline(
        cfg.model,
        download_root=cfg.models_dir,
        language=cfg.language,
        translator=translator,
    )


def _default_date() -> str:
    return _date.today().isoformat()


def _ask_model_dir_early(cfg: Config) -> None:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)


def _summarizer(cfg: Config):
    if cfg.server:
        from .remote import RemoteSummarizer

        return RemoteSummarizer(cfg.server, cfg.server_key)
    from .summarize import OllamaSummarizer

    return OllamaSummarizer(cfg.ollama_url, cfg.summary_model)


def _summary_where(cfg: Config) -> str:
    if cfg.server:
        return f"the model server ({cfg.server})"
    return f"{cfg.summary_model} ({cfg.ollama_url})"


def _summarize_after(cfg: Config, client: LiveClient, journal: Journal, session_id: str,
                     meeting_id: str | None) -> None:
    """The ended session's review draft, written on this PC and posted.

    Never fails the recording: the transcript is already in Taskly, and the
    draft can be made again later with `summarize <session>`.
    """
    from .api import ApiError
    from .summarize import SummaryError, summarize_session

    if not cfg.summary:
        print("  summary : off (--no-summary); run `summarize "
              f"{session_id}` to make one later")
        return
    if not meeting_id:
        # The review card lives in a meeting's panel: a rehearsal has none.
        print("  summary : skipped — this recording isn't linked to a meeting "
              "(record with --meeting <id> to review it into minutes)")
        return
    print(f"  summary : writing the review draft with {_summary_where(cfg)}...")
    try:
        outcome = summarize_session(journal, client, session_id, _summarizer(cfg))
    except (SummaryError, ApiError) as exc:
        print(f"  summary : not made — {exc}")
        print(f"            try again: python -m taskly_live summarize {session_id}")
        return
    print(
        f"  summary : posted for review in {outcome.seconds:.0f}s "
        f"({outcome.decisions} decision(s), {outcome.follow_ups} follow-up(s), "
        f"{outcome.action_items} action item(s))"
    )


# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------
def cmd_start(args: argparse.Namespace, cfg: Config) -> int:
    from .recorder import LiveEngine

    client = _maybe_mock(cfg, bool(getattr(args, "mock", False)))
    _ask_model_dir_early(cfg)
    journal = Journal(cfg.journal_path)
    stt = _build_stt(cfg)
    title = args.title or f"Live meeting {cfg.device or 'desk'}"
    date = args.date if args.date else _default_date()

    engine = LiveEngine(cfg, client, journal, stt, title=title, date=date,
                        meeting_id=args.meeting)
    import signal

    def on_sigint(signum, frame) -> None:  # noqa: ARG001 (signature fixed)
        engine.stop("interrupt")

    signal.signal(signal.SIGINT, on_sigint)
    summary = engine.run(resume=args.resume)
    print()
    print("=== session ended ===")
    print(f"  session : {summary.session_id}")
    print(f"  status  : {summary.end_status}")
    print(f"  title   : {summary.title}")
    print(f"  utterances journalled : {summary.utterances}")
    print(
        f"  delivery: acked={summary.pushed_acked} pending={summary.pushed_pending}"
        f" failed={summary.pushed_failed}"
    )
    if summary.fatal:
        print(f"  FATAL   : {summary.fatal}")
        return 1
    if summary.pushed_pending:
        print(
            "  note: segments are still pending; re-run with "
            f"--resume {summary.session_id} to replay them (idempotent)."
        )
    if summary.end_status == "reviewing":
        _summarize_after(cfg, client, journal, summary.session_id, args.meeting)
    return 0


def cmd_stop(args: argparse.Namespace, cfg: Config) -> int:
    """Handshake: write the stop flag; the engine polls it and exits."""
    if not cfg.state_file.exists():
        print("status: no engine running (no state file).")
        if getattr(args, "end", None):
            _end_stale_session(args.end, cfg)
        return 0
    state = json.loads(cfg.state_file.read_text(encoding="utf-8"))
    print(f"engine: pid={state.get('pid')} session={state.get('session_id')}")
    print("writing stop flag; engine should end the session within a few seconds...")
    flag = cfg.stop_flag
    flag.parent.mkdir(parents=True, exist_ok=True)
    flag.write_text(json.dumps({"requested": time.time()}), encoding="utf-8")
    deadline = time.time() + 45.0
    while time.time() < deadline and cfg.state_file.exists():
        time.sleep(0.5)
    if cfg.state_file.exists():
        print("warning: engine did not exit in time; check its console output.")
        return 1
    if flag.exists():
        flag.unlink()
    print("engine stopped cleanly.")
    return 0


def cmd_status(args: argparse.Namespace, cfg: Config) -> int:
    print("Taskly Live engine status")
    print(f"  data dir : {cfg.data_dir}")
    print(f"  url      : {cfg.url}")
    if cfg.state_file.exists():
        state = json.loads(cfg.state_file.read_text(encoding="utf-8"))
        print(f"  engine   : RUNNING pid={state.get('pid')}")
        print(f"  session  : {state.get('session_id')} {state.get('title')!r}"
              f" ({state.get('status')})")
    else:
        print("  engine   : not running")
    print("  journal:")
    if cfg.journal_path.exists():
        journal = Journal(cfg.journal_path)
        print(journal.session_summary())
    else:
        print("    (no journal yet)")
    return 0


def cmd_replay(args: argparse.Namespace, cfg: Config) -> int:
    from .replay import run_replay

    wav = Path(args.wav).expanduser().resolve()
    if not wav.exists():
        print(f"error: file not found: {wav}", file=sys.stderr)
        return 2
    client = _maybe_mock(cfg, bool(getattr(args, "mock", False)))
    _ask_model_dir_early(cfg)
    journal_ = Journal(cfg.journal_path)
    stt = _build_stt(cfg)
    title = args.title or f"Replay {wav.name}"
    date = args.date if args.date else _default_date()

    t0 = time.perf_counter()
    result = run_replay(
        cfg, client, journal_, stt, wav,
        title=title, date=date, speed=args.speed, meeting_id=args.meeting,
    )
    wall = time.perf_counter() - t0
    counts = result["counts"]
    print()
    print("=== replay done ===")
    print(f"  source  : {wav.name} ({result['duration_s']:.1f}s audio)")
    print(f"  session : {result['session_id']}  pushed to: {result['pushed_to']}")
    if result["fatal"]:
        print(f"  FATAL   : {result['fatal']}")
    print(
        f"  rows    : delivered={result['utterances']} "
        f"skipped={result['skipped_silence']} acked={counts['acked']} "
        f"pending={counts['pending']} failed={counts['failed']}"
    )
    print(
        f"  stt     : audio={result['stt_total_audio_s']:.1f}s "
        f"decode={result['stt_total_decode_s']:.1f}s "
        f"rtf={result['stt_rtf']:.2f}"
    )
    print(f"  wall    : {wall:.1f}s (speed x{args.speed})")
    # The person's own console on their own machine: the lines are shown.
    print("  transcript (lang | original | EN | AR):")
    for lang, text, en, ar in result["lines"]:
        print(f"    [{lang:2s}] {text}")
        if en and en != text:
            print(f"        EN: {en}")
        if ar and ar != text:
            print(f"        AR: {ar}")
    if not result["fatal"]:
        _summarize_after(cfg, client, journal_, result["session_id"], args.meeting)
    fail = 1 if (result["fatal"] or counts.get("failed")) else 0
    return fail


def cmd_summarize(args: argparse.Namespace, cfg: Config) -> int:
    """Write (or rewrite) an ended session's review draft and post it."""
    from .api import ApiError
    from .summarize import SummaryError, summarize_session

    if not cfg.journal_path.exists():
        print(f"error: no journal at {cfg.journal_path}", file=sys.stderr)
        return 2
    journal = Journal(cfg.journal_path)
    if journal.get_session(args.session_id) is None:
        print(f"error: session {args.session_id} isn't in this PC's journal", file=sys.stderr)
        return 2
    client = LiveClient(cfg.url, cfg.token)
    dry = bool(getattr(args, "dry_run", False))
    print(f"writing the review draft with {_summary_where(cfg)}...")
    try:
        outcome = summarize_session(journal, client, args.session_id, _summarizer(cfg),
                                    post=not dry)
    except (SummaryError, ApiError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        if isinstance(exc, ApiError) and exc.status == 404:
            print("  (the session must have ended, and not been reviewed yet)", file=sys.stderr)
        return 1
    if dry:
        # The person's own console, on their own PC: the draft itself is shown.
        print(json.dumps(outcome.draft, ensure_ascii=False, indent=2))
        print(f"(dry run: not posted; {outcome.seconds:.0f}s)")
    else:
        print(
            f"posted for review in {outcome.seconds:.0f}s ({outcome.decisions} decision(s), "
            f"{outcome.follow_ups} follow-up(s), {outcome.action_items} action item(s))"
        )
    return 0


def _wait_for_ollama(url: str, seconds: float) -> bool:
    """At boot Ollama may come up after us: give it a while before the
    translator is picked (AutoTranslator keeps looking afterwards anyway)."""
    import requests

    deadline = time.monotonic() + max(0.0, seconds)
    while True:
        try:
            requests.get(f"{url}/api/version", timeout=2.0)
            return True
        except requests.RequestException:
            if time.monotonic() >= deadline:
                return False
            time.sleep(2.0)


def cmd_serve_keys(args: argparse.Namespace, cfg: Config) -> int:
    """`serve keys add|list|revoke`: one key per platform."""
    from .server import open_key_store

    store = open_key_store(cfg.data_dir)
    try:
        if args.keys_cmd == "add":
            try:
                raw = store.add(args.name, concurrency=args.concurrency)
            except ValueError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 2
            print(f"key for {args.name!r} (shown once; store it in that platform's secrets):")
            print(f"    {raw}")
            return 0
        if args.keys_cmd == "revoke":
            if not store.revoke(args.name):
                print(f"error: no active key named {args.name!r}", file=sys.stderr)
                return 2
            print(f"revoked {args.name!r}: requests with it now get 401")
            return 0
        rows = store.list()
        if not rows:
            print("no keys yet: `python -m taskly_live serve keys add <name>`")
        for k in rows:
            state = f"revoked {k.revoked[:10]}" if k.revoked else "active"
            print(f"{k.name:24s} {state:18s} created {k.created[:10]}  "
                  f"last used {(k.last_used or '-')[:16]:16s}  "
                  f"{k.usage.requests} req, {k.usage.audio_seconds / 60:.1f} audio min, "
                  f"{k.usage.prompt_tokens + k.usage.completion_tokens} tokens"
                  + (f", concurrency {k.concurrency}" if k.concurrency else ""))
        return 0
    finally:
        store.close()


def cmd_serve(args: argparse.Namespace, cfg: Config) -> int:
    """The GPU PC's model server (server.py) until Ctrl-C or the service stops."""
    from .config import DEFAULT_SERVE_MODEL
    from .server import ModelServer, open_key_store, setup_lines
    from .summarize import OllamaSummarizer

    if getattr(args, "keys_cmd", None):
        return cmd_serve_keys(args, cfg)
    if args.new_key:
        print("--new-key is gone: give each platform its own key with "
              "`serve keys add <name>` and retire one with `serve keys revoke <name>`.",
              file=sys.stderr)
        return 2
    keys = open_key_store(cfg.data_dir)
    if not any(k.active for k in keys.list()):
        raw = keys.add("default")
        print("no keys yet; made one named 'default' (shown once):")
        print(f"    {raw}")
    cfg.server = ""  # the server decodes itself, whatever the environment says
    if not cfg.model_from_user:
        cfg.model = DEFAULT_SERVE_MODEL
    if not _wait_for_ollama(cfg.ollama_url, args.wait_ollama):
        print(f"warning: Ollama isn't answering at {cfg.ollama_url} after "
              f"{args.wait_ollama:.0f}s; starting without it (translation and chat "
              "recover when it does)", flush=True)
    print(f"loading {cfg.model} (first run downloads it into {cfg.models_dir})...", flush=True)
    stt = _build_stt(cfg, default_translator="auto", keep_looking=True)
    if args.require_gpu and stt.device != "cuda":
        # Under a service manager: exit so it restarts us once CUDA is ready,
        # rather than serving every platform from the CPU for weeks.
        print(f"error: --require-gpu, but Whisper loaded on {stt.device}; exiting",
              file=sys.stderr, flush=True)
        return 3
    translator = getattr(stt, "translator", None)
    shared = getattr(translator, "model", None) == cfg.summary_model
    if shared:
        # One model translates every line and writes the summaries: keep it
        # loaded for good, or each idle spell costs the next line a cold load.
        translator.keep_alive = -1  # a number: Ollama reads "-1" as a bad duration
    if hasattr(translator, "warm_up"):
        from .translate import TranslationError

        try:
            print(f"warming up {translator.name}: {translator.warm_up():.1f}s")
        except TranslationError as exc:
            print(f"warning: {translator.name} didn't answer ({exc}); lines go "
                  "out untranslated until it does")
    summarizer = OllamaSummarizer(cfg.ollama_url, cfg.summary_model,
                                  keep_alive=-1 if shared else None)
    chat_models = [m.strip() for m in (args.chat_models or "").split(",") if m.strip()]
    try:
        server = ModelServer(stt, summarizer, keys, host=args.host, port=args.port,
                             stt_slots=args.stt_slots, llm_slots=args.llm_slots,
                             per_key=args.per_key, max_queue=args.max_queue,
                             ollama_url=cfg.ollama_url, chat_models=chat_models or None).start()
    except OSError as exc:
        print(f"error: cannot listen on {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 2
    print(f"Taskly model server on {args.host}:{server.port}")
    print(f"  stt        : {stt.model_name} on {stt.device} ({stt.compute_type})")
    print(f"  translator : {translator.name if translator else 'whisper (X -> English only)'}")
    print(f"  summaries  : {summarizer.name} at {cfg.ollama_url}")
    print(f"  chat       : {', '.join(server.chat_allowlist) or 'none'} "
          f"(available now: {', '.join(server.chat_models()) or 'none'})")
    print(f"  queues     : speech {args.stt_slots} slot(s), llm {args.llm_slots}; "
          f"{args.per_key} per key; {args.max_queue} waiting at most")
    for line in setup_lines(server.port, keys):
        print(line)
    print("Ctrl-C to stop.", flush=True)  # a log file (service) sees it now
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
        keys.close()
    return 0


def cmd_test(args: argparse.Namespace, cfg: Config | None) -> int:
    """Contract round-trip against the in-process mock (TEST-ONLY)."""
    from .mock_server import MockServer
    from .pusher import Pusher
    from .api import ApiError, Segment

    port = int(getattr(args, "port", MOCK_PORT))
    server = MockServer.with_ephemeral() if port <= 0 else _mock_on_port(port)
    if server is None:
        print(f"error: mock port {port} is busy; try a different --port", file=sys.stderr)
        return 2
    client = LiveClient(server.url, MOCK_TOKEN, batch_limit=MAX_BATCH)
    import tempfile

    tdir = tempfile.TemporaryDirectory()
    manager: tempfile.TemporaryDirectory = tdir
    journal = Journal(Path(manager.name) / "test.sqlite3")

    print(f"[test] mock server: {server.url}")
    checks = 0
    failures = 0

    def expect(name: str, ok: bool, detail: str = "") -> None:
        nonlocal checks, failures
        checks += 1
        mark = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))

    # 1) session create
    s = client.create_session("Engine selftest", _default_date())
    sid = s["id"]
    expect("session created", s.get("status") == "capturing", f"id={sid}")

    # 2) journalled append assigns monotonic seq across both sources
    seqs = [
        journal.append(sid, source="mic", lang="en", text="hello from the mic",
                       text_en="hello from the mic", started_ms=0, ended_ms=900),
        journal.append(sid, source="system", lang="ar", text="مرحبا",
                       text_en="hello", started_ms=900, ended_ms=1700),
        journal.append(sid, source="mic", lang="en", text="second line",
                       text_en="second line", started_ms=1800, ended_ms=2500),
    ]
    expect("journal seqs per-source monotonic", seqs == [1, 2, 3], str(seqs))

    # 3) pusher pushes them in order
    pusher = Pusher(client, journal, sid, coalesce_s=0.0, backoff=(0.2, 0.5))
    pusher.start()
    _wait_for(lambda: journal.counts(sid)["acked"] == 3, 5.0)
    counts = journal.counts(sid)
    expect("pusher acked 3 rows", counts["acked"] == 3, str(counts))

    # 4) idempotent replay: pushing the SAME (session, seq) again must be a
    #    no-op server-side (the contract's duplicate protection).
    outcome = client.push(
        sid,
        [
            Segment(seq=1, source="mic", lang="en", text="hello from the mic",
                    text_en="hello from the mic", started_ms=0, ended_ms=900),
            Segment(seq=2, source="system", lang="ar", text="مرحبا",
                    text_en="hello", started_ms=900, ended_ms=1700),
        ],
    )
    expect("duplicate push accepted=0", outcome.accepted == 0,
           f"accepted={outcome.accepted} last_seq={outcome.last_seq}")
    expect("duplicate push leaves 3 unique segments",
           len(server.state.sessions[sid]["segments"]) == 3)
    expect("duplicate push leaves last_seq == 3",
           server.state.sessions[sid]["last_seq"] == 3)

    # 5) retry ladder survives an injected 429
    server.state.fail_next.append((429, 1))
    journal.append(sid, source="mic", lang="en", text="after the 429",
                   text_en="after the 429", started_ms=2600, ended_ms=3300)
    _wait_for(lambda: journal.counts(sid)["acked"] == 4, 8.0)
    counts = journal.counts(sid)
    expect("retry after 429 acks the row", counts["acked"] == 4, str(counts))

    # 6) bubbles: fatal 401 marks rows failed, nothing lost
    server.state.fail_next.append((401, 1))
    seq6 = journal.append(sid, source="system", lang="ar", text="لا يزال",
                          text_en="still", started_ms=3400, ended_ms=4000)
    _wait_for(lambda: journal.counts(sid)["failed"] == 1, 8.0)
    counts = journal.counts(sid)
    expect("fatal error -> row marked failed", counts["failed"] == 1, str(counts))
    back = journal.requeue_failed(sid)
    expect("requeue_failed restores pending", back == 1)
    pusher.stop(drain_timeout=5.0)

    # 7) end session
    ended = client.end_session(sid)
    expect("end -> reviewing", ended["session"]["status"] == "reviewing")

    server.stop()
    journal.close()
    manager.cleanup()
    print(f"\n[test] {checks - failures}/{checks} checks passed")
    return 1 if failures else 0


def cmd_mockserve(args: argparse.Namespace, cfg: Config | None) -> int:
    """Standalone TEST-ONLY mock server (offline dev aid)."""
    from .mock_server import MockServer

    port = int(getattr(args, "port", MOCK_PORT))
    state_path = Path(args.state).resolve() if getattr(args, "state", None) else None
    try:
        server = MockServer(port=port, state_path=state_path).start()
    except OSError as exc:
        print(f"error: cannot bind port {port}: {exc}", file=sys.stderr)
        return 2
    print(f"TEST-ONLY mock Taskly: {server.url}  (Ctrl-C to stop)")
    print("Any Bearer token is accepted. State persists to:", state_path or "<memory>")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
    return 0


def _mock_on_port(port: int):  # for cmd_test
    import socket

    from .mock_server import MockServer

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            return None
    return MockServer(port=port).start()


def _end_stale_session(session_id: str, cfg: Config) -> None:
    """Fallback when no engine runs: end a session right from the CLI."""
    try:
        client = LiveClient(cfg.url, cfg.token)
        client.end_session(session_id)
        print(f"ended session {session_id} directly on {cfg.url}")
    except Exception as exc:  # noqa: BLE001
        print(f"error: could not end session {session_id}: {exc}")


def _wait_for(predicate, timeout: float) -> bool:  # tiny polling helper
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


# ---------------------------------------------------------------------------
# argparse
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--url", default=None, help="Taskly base URL (or TASKLY_URL)")
    common.add_argument("--token", default=None, help="device token (or TASKLY_TOKEN)")
    common.add_argument("--model", default=None, help="Whisper model (or TASKLY_MODEL)")
    common.add_argument("--device", default=argparse.SUPPRESS,
                        help="mic device index or name substring (or TASKLY_DEVICE)")
    common.add_argument("--data-dir", default=None,
                        help="dir for journal.sqlite3 (default: engine folder)")
    common.add_argument("--gap-ms", type=int, default=None,
                        help="VAD gap threshold ms (default 700)")
    common.add_argument("--language", choices=["ar", "en"], default=argparse.SUPPRESS,
                        help="force transcription language (default auto)")
    common.add_argument("--ollama-url", default=None,
                        help="local Ollama for the summary (or TASKLY_OLLAMA_URL)")
    common.add_argument("--summary-model", default=None,
                        help="Ollama model for the summary (or TASKLY_SUMMARY_MODEL)")
    common.add_argument("--server", default=None, metavar="URL",
                        help="the PC's model server, e.g. http://100.64.0.7:8765 "
                             "(or TASKLY_MODEL_SERVER)")
    common.add_argument("--server-key", default=None,
                        help="the model server's key (or TASKLY_MODEL_SERVER_KEY)")
    common.add_argument("--system-device", default=None,
                        help="system-audio capture device, index or name substring "
                             "(or TASKLY_SYSTEM_DEVICE)")
    common.add_argument("--translator", default=None,
                        help="per-line Arabic<->English: off | hymt | marian | ollama | auto "
                             "(or TASKLY_TRANSLATOR)")
    common.add_argument("--translate-model", default=None,
                        help="Ollama model for --translator ollama "
                             "(or TASKLY_TRANSLATE_MODEL)")
    common.add_argument("--verbose", "-V", action="store_true")

    parser = argparse.ArgumentParser(
        prog="python -m taskly_live",
        description="Taskly Live capture engine (Python prototype).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", parents=[common], help="live capture session")
    start.add_argument("--title", default=None, help="meeting title")
    start.add_argument("--date", default=None, help="meeting date YYYY-MM-DD")
    start.add_argument("--meeting", default=None, metavar="MEETING_ID",
                       help="the Taskly meeting this records (its ?meeting= id); "
                            "without one it's a private rehearsal with no review card")
    start.add_argument("--mock", action="store_true",
                       help="TEST-ONLY: push to an in-process mock instead of Taskly")
    start.add_argument("--resume", default=None, metavar="SESSION_ID",
                       help="continue a journalled (e.g. crashed) session")
    start.add_argument("--no-mic", action="store_true")
    start.add_argument("--no-system", action="store_true")
    start.add_argument("--no-auto-gain", action="store_true")
    start.add_argument("--no-summary", action="store_true",
                       help="don't write the review draft when the session ends")

    stop = sub.add_parser("stop", parents=[common], help="stop the running engine")
    stop.add_argument("--end", metavar="SESSION_ID", default=None,
                      help="also end a session directly (engine not running)")

    status = sub.add_parser("status", parents=[common], help="print engine state")
    status.add_argument("--debug", action="store_true")

    replay = sub.add_parser("replay", parents=[common], help="deliver a WAV offline")
    replay.add_argument("wav")
    replay.add_argument("--title", default=None)
    replay.add_argument("--date", default=None)
    replay.add_argument("--meeting", default=None, metavar="MEETING_ID",
                        help="the Taskly meeting this recording belongs to")
    replay.add_argument("--speed", type=float, default=1.0,
                        help="replay pacing: 1=realtime, >1 faster (x8 in tests)")
    replay.add_argument("--mock", action="store_true",
                        help="TEST-ONLY: push to an in-process mock instead")
    replay.add_argument("--no-summary", action="store_true",
                        help="don't write the review draft when the replay ends")

    summ = sub.add_parser("summarize", parents=[common],
                          help="write an ended session's review draft with Ollama")
    summ.add_argument("session_id")
    summ.add_argument("--dry-run", action="store_true",
                      help="print the draft instead of posting it")

    serve = sub.add_parser("serve", parents=[common],
                           help="(GPU PC) shared AI model server for every platform")
    serve.add_argument("--host", default="0.0.0.0",
                       help="listen address (default all interfaces)")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--new-key", action="store_true", help=argparse.SUPPRESS)
    serve.add_argument("--stt-slots", type=int, default=1,
                       help="speech decodes at once on the GPU (default 1)")
    serve.add_argument("--llm-slots", type=int, default=2,
                       help="Ollama requests at once (default 2)")
    serve.add_argument("--per-key", type=int, default=1,
                       help="requests one key may run at once per queue (default 1)")
    serve.add_argument("--max-queue", type=int, default=32,
                       help="requests waiting per queue before 429 (default 32)")
    serve.add_argument("--chat-models", default=None, metavar="M1,M2",
                       help="Ollama models offered on /v1/chat/completions "
                            "(default: the summary model)")
    serve.add_argument("--require-gpu", action="store_true",
                       help="exit (code 3) if Whisper can't use CUDA — for a service "
                            "manager to restart")
    serve.add_argument("--wait-ollama", type=float, default=120.0, metavar="SECONDS",
                       help="wait this long for Ollama at start (default 120)")
    serve_sub = serve.add_subparsers(dest="serve_cmd")
    keys = serve_sub.add_parser("keys", help="manage platform keys")
    keys_sub = keys.add_subparsers(dest="keys_cmd", required=True)
    keys_add = keys_sub.add_parser("add", help="new key for a platform (printed once)")
    keys_add.add_argument("name")
    keys_add.add_argument("--concurrency", type=int, default=None,
                          help="this key's own per-queue limit")
    keys_sub.add_parser("list", help="keys, last use and usage")
    keys_revoke = keys_sub.add_parser("revoke", help="retire a platform's key")
    keys_revoke.add_argument("name")

    test = sub.add_parser("test", help="contract round-trip vs TEST-ONLY mock")
    test.add_argument("--port", type=int, default=MOCK_PORT)

    ms = sub.add_parser("mockserve", help="run the TEST-ONLY mock server")
    ms.add_argument("--port", type=int, default=MOCK_PORT)
    ms.add_argument("--state", default=None,
                    help="optional JSON file to persist mock state across runs")

    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:  # argparse --help
        return int(exc.code or 0)
    _install_logging(bool(getattr(args, "verbose", False)))

    mocked = bool(getattr(args, "mock", False)) or \
        getattr(args, "command", None) in ("test", "mockserve")
    cmd = getattr(args, "command", None)
    requires_token = cmd not in ("status", "stop", "serve")
    try:
        cfg = Config.build(args, default_token=MOCK_TOKEN if mocked else "",
                           require_token=requires_token)
    except ValueError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2

    try:
        if args.command == "start":
            return cmd_start(args, cfg)
        if args.command == "stop":
            return cmd_stop(args, cfg)
        if args.command == "status":
            if getattr(args, "debug", False) and cfg.journal_path.exists():
                journal = Journal(cfg.journal_path)
                for row in journal.audit_snapshot():
                    print(row)
            return cmd_status(args, cfg)
        if args.command == "replay":
            return cmd_replay(args, cfg)
        if args.command == "summarize":
            return cmd_summarize(args, cfg)
        if args.command == "serve":
            return cmd_serve(args, cfg)
        if args.command == "test":
            return cmd_test(args, cfg)
        if args.command == "mockserve":
            return cmd_mockserve(args, cfg)
        print(f"unknown command {args.command!r}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        if getattr(args, "verbose", False):
            raise
        log.error("%s failed: %s", args.command, exc, exc_info=False)
        return 1
