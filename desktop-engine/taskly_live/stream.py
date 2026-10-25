"""LAN stream transport: `serve` (PC) + `capture` (laptop) bridge (v0.2).

SUPERSEDED (2026-10): not wired into the CLI and not maintained. The
architecture that shipped keeps the whole pipeline on each laptop and sends
only utterance audio to the PC's model server (`serve` in server.py, client
in remote.py); see README.md and docs/live-meetings.md. Kept for reference.

Server (`StreamServer`)
=======================
An asyncio WebSocket server (websockets>=13). Each connection:

    1. hello  -> validate agent/version/sources, constant-time LAN-token check
                 (reject: error JSON + close 4400 malformed / 4401 auth)
    2. welcome {ok, session_mode: waiting|capturing, session}
    3. frames -> decode base64 int16 -> float32 -> engine.ingest(source, pcm)
                 (the ONE capture-origin boundary from recorder.py)
    4. bye    -> close this connection (lane stays open; session continues
                 until the operator stops `serve`)

Lanes (`LiveEngine` per-source queues) intentionally outlive sockets: a
dropped capture client leaves the lane buffering (>=30 s backlog default,
far larger), the client reconnects and replays its spill FIRST, and the
frame stream continues seamlessly — no audio loss across a reconnect.

Client (`CaptureClient`)
========================
Runs `AudioFeeds` locally (mic + WASAPI loopback), frames 16 kHz float32
into exact sample blocks and streams labelled base64-JSON binary messages.

Threading: audio workers & a single SENDER thread own ordering; the asyncio
loop owns connect/handshake/receive/reconnect. The outbox is a thread-safe
ordered deque of RAW int16 frames; while OFFLINE feeds go to `SpillRing`s.
On disconnect, queued-but-unsent frames are spliced into the spill rings in
capture order, so replay order equals capture order. Reconnect backoff
1 -> 2 -> 5 -> 15 -> 30 s (cap). Graceful end: {"type":"bye"} then a clean
close; a server {"type":"closing"} (engine shutting down) exits the capture
process instead of reconnecting.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np

from . import audio, protocol
from .protocol import SOURCE_IDS, MAX_FRAME_BYTES, SourceSpec
from .spill import SpillRing, SPILL_FLUSH_S

log = logging.getLogger(__name__)

RECONNECT_DELAYS = (1.0, 2.0, 5.0, 15.0, 30.0)
DEFAULT_OUTBOX_FRAMES = 1500   # ~30 s of 20 ms frames; drop-oldest beyond
HEARTBEAT_S = 4.0              # idle keepalive chatter (LAN NAT friendliness)
EOF_GRACE_S = 30.0             # keep trying to deliver an ended file offline
BYE_GRACE_S = 1.0              # wait after EOF before queuing bye


class FatalAuthError(RuntimeError):
    """LAN token rejected — retrying handshakes cannot help."""


# ===========================================================================
# SERVER (runs on the PC, inside `serve`)
# ===========================================================================
class StreamServer:
    """WebSocket front-end feeding `LiveEngine.ingest` (streaming mode)."""

    def __init__(
        self,
        engine,  # recorder.LiveEngine in streaming mode
        *,
        lan_token: str,
        host: str = "0.0.0.0",
        port: int = 8765,
        allowed_sources: set[str] | None = None,
    ) -> None:
        self.engine = engine
        self.lan_token = lan_token
        self.host = host
        self.port = int(port)
        self.allowed = allowed_sources or set(SOURCE_IDS)
        self._shutdown_evt = threading.Event()
        self._shutdown_reason = "engine stopped"
        self._ready = threading.Event()
        self._conns: set = set()
        self.bound_port: int | None = None
        self.stats = {
            "conns_total": 0,
            "frames": 0,
            "bad_frames": 0,
            "auth_failures": 0,
            "gaps": 0,
        }

    # ---- lifecycle ---------------------------------------------------------
    def request_shutdown(self, reason: str = "engine stopped") -> None:
        self._shutdown_reason = reason
        self._shutdown_evt.set()

    def wait_ready(self, timeout: float = 10.0) -> bool:
        return self._ready.wait(timeout)

    async def run(self) -> None:
        """Serve until request_shutdown(); announces 'closing' to clients."""
        from websockets.asyncio.server import serve

        async with serve(
            self._handler, self.host, self.port,
            max_size=MAX_FRAME_BYTES, ping_interval=20, open_timeout=10,
        ) as srv:
            self.bound_port = srv.sockets[0].getsockname()[1]
            self._ready.set()
            log.info("stream: listening on %s:%d (engine mode=%s)",
                     self.host, self.bound_port,
                     "streaming" if self.engine.streaming else "local")
            while not self._shutdown_evt.is_set():
                await asyncio.sleep(0.25)
            await self._announce_closing(self._shutdown_reason)
            await asyncio.sleep(0.1)  # let close frames flush

    # ---- connection handler --------------------------------------------------
    async def _handler(self, ws) -> None:
        peer = getattr(ws.remote_address, "__str__", lambda: "?")()
        self.stats["conns_total"] += 1
        last_seq: dict[str, int] = {}
        specs: dict[str, SourceSpec] = {}
        try:
            try:
                raw = await asyncio.wait_for(ws.recv(), protocol.HELLO_TIMEOUT_S)
            except (TimeoutError, asyncio.TimeoutError):
                log.info("%s: hello timeout", peer)
                return
            obj = protocol.parse_message(raw)
            if obj.get("type") != "hello":
                await self._reject(ws, protocol.CLOSE_PROTOCOL, "protocol",
                                   "expected hello first")
                return
            if not protocol.check_token(self.lan_token, str(obj.get("token", ""))):
                self.stats["auth_failures"] += 1
                log.warning("%s: LAN token rejected", peer)
                await self._reject(ws, protocol.CLOSE_AUTH, "auth",
                                   "LAN pairing token mismatch")
                return
            specs_list = protocol.decode_hello(obj, allowed_sources=self.allowed)
            specs = {s.id: s for s in specs_list}
            mode = "capturing" if self.engine.session_id else "waiting"
            session = self.engine.session_id
            await ws.send(protocol.build_welcome(mode, session))
            log.info("%s: connected (sources=%s, session_mode=%s)",
                     peer, [s.id for s in specs_list], mode)

            async for raw in ws:
                msg = protocol.parse_message(raw)
                mtype = msg["type"]
                if mtype == "frame":
                    sid, seq, pcm = protocol.decode_frame(msg, specs)
                    last = last_seq.get(sid)
                    if last is not None and seq > last + 1:
                        missing = seq - last - 1
                        self.stats["gaps"] += missing
                        log.info("%s: %s seq gap (%d frames)", peer, sid, missing)
                    last_seq[sid] = seq
                    self.stats["frames"] += 1
                    # THE capture-origin boundary: same call local audio makes.
                    self.engine.ingest(sid, pcm)
                elif mtype == "heartbeat":
                    pass
                elif mtype == "bye":
                    log.info("%s: bye (lane stays open)", peer)
                    break
                else:
                    log.debug("%s: ignoring message type %r", peer, mtype)
            try:
                await ws.close(code=1000, reason="bye")
            except Exception:  # noqa: BLE001 - already gone
                pass
        except protocol.ProtocolError as exc:
            self.stats["bad_frames"] += 1
            log.warning("%s: protocol error: %s", peer, exc)
            self._schedule_reject(ws, exc.code, exc.reply)
        except Exception as exc:  # noqa: BLE001 - socket dropped mid-stream
            log.info("%s: connection ended (%s)", peer,
                     type(exc).__name__ if not isinstance(exc, str) else exc)
        finally:
            self._conns.discard(ws)

    def _schedule_reject(self, ws, code: int, reply: dict) -> None:
        """Best-effort error+close outside the receive context."""
        async def _reject_task():
            await self._reject(ws, code, "protocol", str(reply))
        try:
            asyncio.get_running_loop().create_task(_reject_task())
        except RuntimeError:  # pragma: no cover
            pass

    async def _reject(self, ws, code: int, err_code: str, message: str) -> None:
        try:
            await ws.send(protocol.build_error(err_code, message))
            await ws.close(code=code, reason=err_code)
        except Exception:  # noqa: BLE001
            pass

    async def _announce_closing(self, reason: str) -> None:
        for ws in list(self._conns):
            try:
                await asyncio.wait_for(ws.send(protocol.build_closing(reason)), 2)
                await ws.close(code=1000, reason="closing")
            except Exception:  # noqa: BLE001 - dying conn
                pass
            finally:
                self._conns.discard(ws)


# ===========================================================================
# CLIENT (runs on the laptop, inside `capture`)
# ===========================================================================
class _FramePump:
    """float32 chunks -> exact frame_size blocks (carries the remainder)."""

    def __init__(self, frame_size: int) -> None:
        self.frame_size = int(frame_size)
        self._buf = np.zeros(0, dtype=np.float32)

    def fragment(self, pcm: np.ndarray) -> list[np.ndarray]:
        if pcm.size:
            buf = np.concatenate([self._buf, pcm.astype(np.float32, copy=False)]) \
                if self._buf.size else pcm.astype(np.float32, copy=False)
            self._buf = buf
        n_frames = self._buf.size // self.frame_size
        if n_frames == 0:
            return []
        fs = self.frame_size
        blocks = [self._buf[i * fs:(i + 1) * fs] for i in range(n_frames)]
        self._buf = self._buf[n_frames * fs:]
        return blocks


class CaptureClient:
    """Laptop-side client: capture -> frame -> WebSocket (reconnecting)."""

    def __init__(
        self,
        *,
        url: str,
        lan_token: str,
        sources: list[SourceSpec],
        spill_dir: Path,
        mic: bool = True,
        system: bool = True,
        device: str | int | None = None,
        auto_gain: bool = True,
        outbox_max_frames: int = DEFAULT_OUTBOX_FRAMES,
        stop_flag: Path | None = None,
        replay_source: str | None = None,
        replay_speed: float = 1.0,
        reconnect_delays: tuple[float, ...] = RECONNECT_DELAYS,
    ) -> None:
        self.url = url
        self.lan_token = lan_token
        self.sources = list(sources)
        self._frames_by_source = {s.id: s.frame_size for s in sources}
        self.spill_dir = Path(spill_dir)
        self.mic = mic
        self.system = system
        self.device = device
        self.auto_gain = auto_gain
        self.outbox_max = int(outbox_max_frames)
        self.stop_flag = stop_flag
        self.replay_source = replay_source
        self.replay_speed = replay_speed
        self.reconnect_delays = reconnect_delays

        self._lock = threading.Lock()
        self._outbox: "deque[tuple[str, str, bytes]]" = deque()
        self._online = False
        self._ws = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._seqs: dict[str, int] = {s.id: 0 for s in sources}
        self._pumps: dict[str, _FramePump] = {}
        self._spills = {
            s.id: SpillRing(s.id, self.spill_dir) for s in sources
        }
        self._feeds: audio.AudioFeeds | None = None
        self._replay_thread: threading.Thread | None = None

        self._stop_evt = threading.Event()
        self._eof = threading.Event()
        self._eof_at: float | None = None
        self._bye_queued = False
        self._bye_sent = False
        self._closing_seen: str | None = None
        self._last_error: tuple[str, str] | None = None
        self._sender: threading.Thread | None = None

        self._last_send = 0.0
        self.stats = {
            "frames_sent": 0,
            "outbox_drops": 0,
            "reconnects": 0,
            "heartbeats": 0,
        }

    # ---- capture-side entry (any thread) -------------------------------------
    def feed(self, source: str, pcm: np.ndarray) -> None:
        """AudioFeeds callback: fragment and route frames (per-source order)."""
        if self._stop_evt.is_set():
            return
        pump = self._pumps.get(source)
        if pump is None:
            fs = self._frames_by_source.get(source)
            if fs is None:
                return  # undeclared source: ignore (should not happen)
            pump = self._pumps[source] = _FramePump(fs)
        blocks = pump.fragment(pcm)
        if not blocks:
            return
        if source not in self._spills:
            self._spills[source] = SpillRing(source, self.spill_dir)
        now = time.monotonic()
        for blk in blocks:
            raw = (np.clip(blk, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            with self._lock:
                online = self._online
                if online:
                    while len(self._outbox) >= self.outbox_max:
                        self._outbox.popleft()
                        self.stats["outbox_drops"] += 1
                    self._outbox.append(("f", source, raw))
                offline_flush_ok = True
            if online:
                continue
            spill = self._spills[source]
            spill.add(raw)
            spill.maybe_flush(now)
        # periodic spill disk refresh for all lanes while offline
        if not online:
            for spill in self._spills.values():
                spill.maybe_flush(now + 0.001)

    # ---- stop/bye ------------------------------------------------------------
    def stop(self, reason: str = "interrupt") -> None:
        self._stop_evt.set()
        self._queue_bye(force=True)

    def _queue_bye(self, force: bool = False) -> None:
        with self._lock:
            if self._bye_queued and not force:
                return
            self._bye_queued = True
            self._outbox.append(("bye", "", b""))
        self._stop_evt.clear() if False else None

    def _maybe_queue_bye_after_eof(self, now: float) -> None:
        """When the file feeder ended: queue bye once the outbox drains."""
        if not self._eof.is_set() or self._bye_queued:
            return
        if self._eof_at is None:
            self._eof_at = now
        if now - self._eof_at < BYE_GRACE_S:
            return
        with self._lock:
            pending = bool(self._outbox)
        if pending:
            return
        self._queue_bye()

    def _check_stop_flag(self) -> None:
        if self.stop_flag is None or self._stop_evt.is_set():
            return
        if self.stop_flag.exists():
            log.info("capture: local stop flag seen")
            self.stop("stop flag")

    # ---- sender thread (owns the wire) ---------------------------------------
    def _sender_loop(self) -> None:
        loop = self._loop
        while not self._stop_evt.is_set():
            self._check_stop_flag()
            now = time.monotonic()
            self._maybe_queue_bye_after_eof(now)
            with self._lock:
                item = self._outbox[0] if self._outbox else None
                ws = self._ws
            if item is None or ws is None:
                if ws is not None and now - self._last_send > HEARTBEAT_S:
                    self._send_text(ws, protocol.build_heartbeat(),
                                    is_heartbeat=True)
                self._stop_evt.wait(0.05)
                continue
            kind, source, raw = item
            try:
                if kind == "bye":
                    if not self._send_text(ws, protocol.build_bye()):
                        continue
                    fut = asyncio.run_coroutine_threadsafe(
                        ws.close(code=1000, reason="bye"), loop
                    )
                    fut.result(timeout=8)
                else:
                    seq = self._seqs[source] = self._seqs.get(source, 0) + 1
                    pcm = np.frombuffer(raw, dtype="<i2")
                    payload = protocol.build_frame(source, seq, pcm)
                    fut = asyncio.run_coroutine_threadsafe(
                        ws.send(payload), loop
                    )
                    fut.result(timeout=8)
            except Exception as exc:  # noqa: BLE001 - any send failure: drop
                log.debug("send failed (%s); connection dropped", exc)
                self._on_conn_broken(ws)
                continue
            with self._lock:
                if self._ws is ws and self._outbox and self._outbox[0][0] != "bye":
                    # pop only frames; bye stays until confirmed sent below
                    self._outbox.popleft()
                self._last_send = time.monotonic()
            if kind == "f":
                with self._lock:
                    self.stats["frames_sent"] += 1
            if kind == "bye":
                with self._lock:
                    if self._outbox and self._outbox[0][0] == "bye":
                        self._outbox.popleft()
                    self._bye_sent = True

    def _send_text(self, ws, text: str, *, is_heartbeat: bool = False) -> bool:
        try:
            fut = asyncio.run_coroutine_threadsafe(ws.send(text), self._loop)
            fut.result(timeout=8)
            self._last_send = time.monotonic()
            if is_heartbeat:
                self.stats["heartbeats"] += 1
            return True
        except Exception as exc:  # noqa: BLE001
            log.debug("text send failed (%s)", exc)
            self._on_conn_broken(ws)
            return False

    def _on_conn_broken(self, ws) -> None:
        with self._lock:
            if self._ws is not ws:
                return  # stale sender state
            self._ws = None
            self._online = False
            unsent = [it for it in self._outbox if it[0] == "f"]
            self._outbox.clear()
        for _kind, source, raw in unsent:
            if source in self._spills:
                self._spills[source].add(raw)
            else:
                self._spills.setdefault(
                    source, SpillRing(source, self.spill_dir)
                ).add(raw)

    # ---- connection lifecycle (asyncio side) ---------------------------------
    async def _run_connection(self) -> str:
        """One connect->handshake->pump cycle. Returns an exit reason or
        raises (retryable)."""
        from websockets.asyncio.client import connect

        async with connect(
            self.url, max_size=MAX_FRAME_BYTES, ping_interval=20,
            open_timeout=10, close_timeout=5,
        ) as ws:
            await ws.send(protocol.build_hello(self.sources, self.lan_token))
            try:
                first_raw = await asyncio.wait_for(ws.recv(), 10.0)
            except (TimeoutError, asyncio.TimeoutError) as exc:
                raise ConnectionError("no welcome within 10 s") from exc
            first = protocol.parse_message(first_raw)
            if first.get("type") != "welcome":
                if first.get("type") == "error":
                    self._last_error = (
                        str(first.get("code", "?")),
                        str(first.get("message", ""))[:200],
                    )
                code = getattr(ws, "close_code", None)
                if code == protocol.CLOSE_AUTH or \
                        (self._last_error and self._last_error[0] == "auth"):
                    raise FatalAuthError(
                        f"LAN token rejected: {self._last_error}"
                    )
                raise ConnectionError(f"handshake rejected: {self._last_error}")
            mode = first.get("session_mode", "?")
            session = first.get("session")
            print(
                f"capture: connected to {self.url} "
                f"(session_mode={mode}"
                + (f", session={session}" if session else ")") + ")"
                if isinstance(session, str) else
                f"capture: connected to {self.url} (session_mode={mode})"
            )
            # Splice spill FIRST so replay precedes live; sender may then go.
            self._go_online(ws)
            log.info("capture: ready (spill drained=%s)",
                     sum(sp.buffered_s() for sp in self._spills.values()) == 0)

            try:
                async for raw in ws:
                    msg = protocol.parse_message(raw)
                    mtype = msg["type"]
                    if mtype == "closing":
                        self._closing_seen = str(msg.get("reason", ""))
                        log.info("capture: server is closing (%s)",
                                 self._closing_seen)
                        return "server-closing"
                    if mtype == "error":
                        self._last_error = (
                            str(msg.get("code", "?")),
                            str(msg.get("message", ""))[:200],
                        )
                    # heartbeat/others: ignore
            except protocol.ProtocolError as exc:
                log.error("capture: bad server message: %s", exc)
            finally:
                pass
            return "closed"

    def _go_online(self, ws) -> None:
        with self._lock:
            self._online = True
        drained: list[tuple[str, str, bytes]] = []
        for src in sorted(self._spills):
            for raw in self._spills[src].drain():
                drained.append(("f", src, raw))
        with self._lock:
            if drained:
                self._outbox.extendleft(reversed(drained))
            self._ws = ws

    # ---- main loop -------------------------------------------------------------
    async def run(self) -> int:
        """Run until graceful end (bye/closing/stop flag), crash or EOF."""
        self._loop = asyncio.get_running_loop()
        self._sender = threading.Thread(
            target=self._sender_loop, name="ws-send", daemon=True
        )
        self._sender.start()
        try:
            self._start_feeder()
        except audio.AudioDeviceError as exc:
            print(f"error: {exc}")
            return 2
        log.info("capture: streaming %s to %s",
                 [s.id for s in self.sources], self.url)

        delays = list(self.reconnect_delays)
        attempt = 0
        rc = 0
        try:
            while not self._stop_evt.is_set():
                reason = ""
                try:
                    reason = await self._run_connection()
                except FatalAuthError as exc:
                    print(f"error: {exc}")
                    return 3
                except Exception as exc:  # noqa: BLE001 - network level
                    reason = f"{type(exc).__name__}: {exc}"
                self._on_conn_broken(self._ws) if self._ws else None
                if self._closing_seen is not None or self._bye_sent:
                    log.info("capture: done (%s)", "server closing"
                             if self._closing_seen is not None else "bye")
                    rc = 0
                    break
                if self._stop_evt.is_set() or (
                    self._eof.is_set() and self._offline_too_long()
                ):
                    rc = 0
                    break
                attempt += 1
                self.stats["reconnects"] += 1
                delay = delays[min(attempt - 1, len(delays) - 1)]
                log.warning(
                    "capture: connection lost (%s); reconnect #%d in %.0fs",
                    reason[:160], attempt, delay,
                )
                print(f"capture: connection lost; retrying in {delay:.0f}s "
                      f"(spill: {self._spill_total_s():.1f}s buffered)")
                self._flush_spills()
                await asyncio.sleep(delay)
        finally:
            self._stop_evt.set()
            try:
                if self._feeds is not None:
                    await asyncio.to_thread(self._feeds.stop)
            except Exception as exc:  # noqa: BLE001
                log.debug("feeds stop: %s", exc)
            if self._replay_thread is not None:
                self._replay_thread.join(timeout=5)
            self._flush_spills()
            self._sender.join(timeout=5)
        return rc

    def _offline_too_long(self) -> bool:
        """EOF'd and still offline past the grace window: give up (spill kept)."""
        left = self._spill_total_s()
        if left <= 0.0:
            return True
        if self._eof_at is None:
            self._eof_at = time.monotonic()
        overdue = time.monotonic() - self._eof_at > EOF_GRACE_S
        if overdue:
            log.warning(
                "capture: spill still holds %.1fs of undelivered audio; "
                "it stays on disk and replays on the next run", left,
            )
        return overdue

    def _spill_total_s(self) -> float:
        return sum(sp.buffered_s() for sp in self._spills.values())

    def _flush_spills(self) -> None:
        for spill in self._spills.values():
            try:
                spill.flush_now()
            except Exception as exc:  # noqa: BLE001
                log.debug("spill flush failed: %s", exc)

    # ---- feeders ---------------------------------------------------------------
    def _start_feeder(self) -> None:
        if self.replay_source:
            self._replay_thread = threading.Thread(
                target=self._replay_loop, name="replay-feeder", daemon=True
            )
            self._replay_thread.start()
            return
        if not self.mic and not self.system:
            raise audio.AudioDeviceError(
                "--no-mic plus --no-system: nothing to capture"
            )
        self._feeds = audio.AudioFeeds(
            self.feed, mic=self.mic, system=self.system,
            device=self.device, auto_gain=self.auto_gain,
        )
        self._feeds.start()

    def _replay_loop(self) -> None:
        """TEST-ONLY: stream a local file in place of the laptop's devices."""
        from .replay import load_pcm_mono_16k

        path = Path(self.replay_source).expanduser().resolve()
        pcm, _rate, duration = load_pcm_mono_16k(path)
        log.info("replay- feeder: %s (%.1fs, speed x%g)", path.name,
                 duration, self.replay_speed)
        speed = self.replay_speed if self.replay_speed > 0 else 1.0
        chunk = RATE // 10  # 100 ms
        t0 = time.monotonic()
        stop_on_death = False
        for i in range(0, max(1, len(pcm)), chunk):
            if self._stop_evt.is_set():
                stop_on_death = True
                break
            self.feed("mic", pcm[i:i + chunk])
            if self.replay_speed > 0:
                target = t0 + (i + chunk) / RATE / speed
                delay = target - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
        del stop_on_death
        self._eof.set()
        log.info("replay-feeder: EOF")

    # ---- reporting ---------------------------------------------------------------
    def total_s(self) -> float:
        return sum(
            self._seqs.get(s.id, 0) * (s.frame_ms / 1000.0)
            for s in self.sources
        )
