"""Concurrent microphone + system-audio capture feeding 16 kHz mono float32.

Per source:
  * microphone via `sounddevice` (PortAudio/WASAPI), device chosen by
    TASKLY_DEVICE/--device (index or name substring, default = system default);
  * system audio, per OS (chosen by `_system_source_for`):
      - Windows: `pyaudiowpatch` WASAPI loopback of the default render
        endpoint (or of the loopback device named by --system-device) —
        captures whatever the meeting app plays, independent of the physical
        output device (headphones included);
      - macOS: a loopback *input* device (BlackHole by default) opened through
        `sounddevice`, since CoreAudio has no native loopback;
      - Linux: `parec` on the default sink monitor (PulseAudio / PipeWire-pulse),
        falling back to a "monitor" input device through `sounddevice`.
    Platform-only libraries are imported lazily, so this module imports on
    every OS.

Level care (spec: "gain guard, simple clipping detection"):
  * clipping: fraction of samples above the near-1.0 rail is counted per
    block; sustained clipping auto-attenuates the pre-delivery gain and logs.
  * quiet-gain (microphone only): if the level stays near-silently low the
    gain slowly rises to a capped +18 dB so VAD/STT have a usable signal.
  * gain application is peak-limited: output never clips even after boost.

Both sources run concurrently, each on its own worker thread; chunks are
labelled "mic" / "system" and resampled to 16 kHz mono before delivery.
Audio is consumed in-process only — it is never written to disk by this
module and never leaves the PC (only --replay reads a local file).
"""

from __future__ import annotations

import logging
import queue
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

log = logging.getLogger(__name__)

SOURCE_MIC = "mic"
SOURCE_SYSTEM = "system"

TARGET_RATE = 16000
BLOCK_SECONDS = 0.1  # source read granularity
QUEUE_BLOCKS = 100  # ~10 s of buffering before drop-oldest kicks in

MACOS_LOOPBACK_NAME = "BlackHole"  # default name substring of the macOS loopback input
LINUX_DEFAULT_MONITOR = "@DEFAULT_MONITOR@"  # parec alias for the default sink's monitor
PAREC_SETTLE_SECONDS = 0.4  # parec still alive after this long = it connected


class AudioDeviceError(RuntimeError):
    """Raised when no requested audio source could be opened."""


ChunkCallback = Callable[[str, np.ndarray], None]


def _sounddevice() -> Any:
    """Import `sounddevice` on first use (PortAudio may be missing on Linux)."""
    try:
        import sounddevice as sd
    except (ImportError, OSError) as exc:
        raise AudioDeviceError(f"sounddevice/PortAudio is unavailable: {exc}") from exc
    return sd


def _pyaudio() -> Any:
    """Import `pyaudiowpatch` (Windows only) on first use."""
    try:
        import pyaudiowpatch as pyaudio
    except ImportError as exc:
        raise AudioDeviceError(
            "WASAPI loopback needs PyAudioWPatch (pip install PyAudioWPatch)"
        ) from exc
    return pyaudio


def _push(out: "queue.Queue[tuple[int, np.ndarray]]", rate: int,
          block: np.ndarray) -> None:
    """Queue a block, dropping the oldest when full (keeps realtime flow)."""
    try:
        out.put_nowait((rate, block))
    except queue.Full:
        try:
            out.get_nowait()
            out.put_nowait((rate, block))
        except (queue.Empty, queue.Full):  # pragma: no cover
            pass


@dataclass
class SourceStats:
    """Level/quality counters surfaced by the CLI (observability)."""

    source: str
    blocks: int = 0
    dropped_blocks: int = 0
    clipped_blocks: int = 0
    gain: float = 1.0
    last_peak: float = 0.0
    last_rms: float = 0.0

    def describe(self) -> str:
        return (
            f"{self.source}: blocks={self.blocks} gain=x{self.gain:.2f} "
            f"peak={self.last_peak:.2f} rms={self.last_rms:.4f} "
            f"clipped_blocks={self.clipped_blocks} dropped={self.dropped_blocks}"
        )


class _Worker(threading.Thread):
    """Pumps resampled/gain-guarded chunks from a device queue to the callback."""

    def __init__(self, source: str, clip: "queue.Queue[tuple[int, np.ndarray]]",
                 on_chunk: ChunkCallback, *, auto_gain: bool, boost_ok: bool) -> None:
        super().__init__(name=f"audio-{source}", daemon=True)
        self.source = source
        self.q = clip
        self.on_chunk = on_chunk
        self.auto_gain = auto_gain
        self.boost_ok = boost_ok  # mic: may boost; loopback: attenuate only
        self.stats = SourceStats(source)
        self._gain = 1.0
        self._clipped_run = 0
        self._quiet_run = 0
        self._warned_at = 0.0

    def run(self) -> None:
        while True:
            try:
                rate, block = self.q.get(timeout=1.0)
            except queue.Empty:
                continue
            self._deliver(rate, block)

    def _deliver(self, rate: int, block: np.ndarray) -> None:
        s = self.stats
        s.blocks += 1
        x = block.astype(np.float32, copy=False)

        peak = float(np.max(np.abs(x))) if x.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
        s.last_peak, s.last_rms = peak, rms

        # Clipping detection + attenuation ladder.
        clipped_frac = float(np.count_nonzero(np.abs(x) > 0.985)) / max(x.size, 1)
        if clipped_frac > 0.01:
            s.clipped_blocks += 1
            self._clipped_run += 1
            if self._clipped_run >= 5 and self._gain > 0.25:
                self._gain = max(0.25, self._gain * 0.6)
                log.warning(
                    "%s: sustained clipping %d blocks; gain -> x%.2f",
                    self.source, self._clipped_run, self._gain,
                )
        else:
            self._clipped_run = 0

        # Gentle auto-gain for chronically quiet inputs (mic only).
        if self.auto_gain and self.boost_ok:
            if rms < 0.006:
                self._quiet_run += 1
                if self._quiet_run >= 30 and self._gain < 8.0:  # ~3 s of silence
                    self._gain = min(8.0, self._gain * 1.5)
                    log.info("%s: level low, auto-gain -> x%.2f",
                             self.source, self._gain)
                    self._quiet_run = 0
            else:
                self._quiet_run = 0

        y = x * self._gain
        max_val = float(np.max(np.abs(y))) if y.size else 0.0
        if max_val > 1.0:  # peak-limited: never deliver clipping we made
            y *= 0.985 / max_val
            self._gain = max(0.25, self._gain * 0.9)
        self.stats.gain = self._gain

        mono16 = resample_to_16k(y, rate)
        if mono16.size:
            self.on_chunk(self.source, mono16)


def resample_to_16k(x: np.ndarray, rate: int) -> np.ndarray:
    """Linear-interpolation resample to the 16 kHz VAD/STT rate (mono)."""
    if rate == TARGET_RATE or x.size == 0:
        return x.astype(np.float32, copy=False)
    target_len = max(1, int(round(x.size * TARGET_RATE / rate)))
    return np.interp(
        np.linspace(0.0, x.size - 1, target_len, dtype=np.float64),
        np.arange(x.size, dtype=np.float64),
        x.astype(np.float64, copy=False),
    ).astype(np.float32)


class MicSource(threading.Thread):
    """sounddevice InputStream -> numpy blocks of (rate, float32)."""

    def __init__(self, out: "queue.Queue[tuple[int, np.ndarray]]",
                 device: str | int | None, stop: threading.Event,
                 stats: SourceStats | None = None) -> None:
        super().__init__(name="mic-source", daemon=True)
        self.out = out
        self.device = device
        self.stop_event = stop
        self.ready = threading.Event()
        self.error: Exception | None = None

    def run(self) -> None:
        try:
            self._run_stream()
        except Exception as exc:  # thread boundary: surface to AudioFeeds
            self.error = exc
            log.error("mic capture failed: %s", exc)
        finally:
            self.ready.set()

    def _resolve_device(self) -> tuple[int, dict]:
        sd = _sounddevice()
        default_idx, _ = sd.default.device
        if self.device is None or self.device == "":
            return int(default_idx), sd.query_devices(int(default_idx))
        if isinstance(self.device, int) or self.device.isdigit():
            return int(self.device), sd.query_devices(int(self.device))
        needle = str(self.device).lower()
        for idx, dev in enumerate(sd.query_devices()):
            if (
                dev.get("max_input_channels", 0) > 0
                and needle in dev["name"].lower()
            ):
                return idx, dev
        raise AudioDeviceError(f"no input device matching {self.device!r}")

    def _run_stream(self) -> None:
        sd = _sounddevice()
        idx, dev = self._resolve_device()
        rate = int(dev.get("default_samplerate") or 48000)
        channels = int(min(1, dev.get("max_input_channels", 1))) or 1
        blocksize = int(rate * BLOCK_SECONDS)
        log.info(
            "mic: opening %r (index %s, %d Hz, %d ch)",
            dev["name"], idx, rate, channels,
        )
        dropped = {"n": 0}

        def callback(indata, frames, time_info, status):  # type: ignore[no-untyped-def]
            if status:
                log.debug("mic: %s", status)
            block = indata[:, 0].copy() if channels == 1 \
                else indata.mean(axis=1, dtype=np.float32).copy()
            try:
                self.out.put_nowait((rate, block))
            except queue.Full:
                dropped["n"] += 1
                try:
                    _ = self.out.get_nowait()  # drop-oldest keeps realtime flow
                    self.out.put_nowait((rate, block))
                except (queue.Empty, queue.Full):  # pragma: no cover
                    pass

        with sd.InputStream(
            device=idx, samplerate=rate, channels=channels, dtype="float32",
            blocksize=blocksize, callback=callback,
        ):
            self.ready.set()
            self.stop_event.wait()


class SystemLoopbackSource(threading.Thread):
    """Windows: pyaudiowpatch WASAPI loopback (default render endpoint, or the
    loopback device named by `device`: index or name substring)."""

    def __init__(self, out: "queue.Queue[tuple[int, np.ndarray]]",
                 stop: threading.Event, stats: SourceStats | None = None,
                 device: str | int | None = None) -> None:
        super().__init__(name="system-source", daemon=True)
        self.out = out
        self.stop_event = stop
        self.device = device
        self.ready = threading.Event()
        self.error: Exception | None = None

    def run(self) -> None:
        try:
            self._run_stream()
        except Exception as exc:
            self.error = exc
            log.error("system loopback failed: %s", exc)
        finally:
            self.ready.set()

    @staticmethod
    def _find_loopback(p: Any, device: str | int | None = None) -> dict:
        pyaudio = _pyaudio()
        if device is not None and str(device) != "":
            wanted = str(device)
            loopbacks = [dict(d) for d in p.get_loopback_device_info_generator()]
            for dev in loopbacks:
                if wanted.isdigit():
                    if dev.get("index") == int(wanted):
                        return dev
                elif wanted.lower() in str(dev.get("name", "")).lower():
                    return dev
            names = ", ".join(repr(d.get("name")) for d in loopbacks) or "none"
            raise AudioDeviceError(
                f"no WASAPI loopback device matching {device!r} (available: {names})"
            )
        try:
            return dict(p.get_default_wasapi_loopback())
        except Exception:  # fall through to generator scan
            log.debug("get_default_wasapi_loopback failed; scanning devices")
        loopbacks = [dict(d) for d in p.get_loopback_device_info_generator()]
        if not loopbacks:
            raise AudioDeviceError(
                "no WASAPI loopback devices found (is any output bound?)"
            )
        try:
            wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
            out_dev = p.get_device_info_by_index(wasapi["defaultOutputDevice"])
            name = out_dev.get("name", "")
            for dev in loopbacks:
                if name and name in dev.get("name", ""):
                    return dev
        except Exception:  # noqa: S110 - fall back to first loopback
            pass
        return loopbacks[0]

    def _run_stream(self) -> None:
        pyaudio = _pyaudio()
        pa = pyaudio.PyAudio()
        try:
            dev = self._find_loopback(pa, self.device)
            rate = int(dev.get("defaultSampleRate") or 48000)
            channels = int(max(1, dev.get("maxInputChannels", 2)))
            frames = int(rate * BLOCK_SECONDS)
            log.info(
                "system: loopback %r (index %s, %d Hz, %d ch)",
                dev.get("name"), dev.get("index"), rate, channels,
            )
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                input_device_index=int(dev["index"]),
                frames_per_buffer=frames,
            )
            self.ready.set()
            while not self.stop_event.is_set():
                data = stream.read(frames, exception_on_overflow=False)
                block = np.frombuffer(data, dtype=np.int16).astype(np.float32)
                if channels > 1:
                    block = block.reshape(-1, channels).mean(axis=1)
                block /= 32768.0
                _push(self.out, rate, block)
            stream.stop_stream()
            stream.close()
        finally:
            pa.terminate()


def _find_input_device(sd: Any, spec: str | int | None,
                       needle: str | None) -> tuple[int, dict] | None:
    """Input device by `spec` (index or name substring), else by `needle`.

    Returns None when nothing matches; only input-capable devices qualify."""
    wanted = str(spec) if spec is not None and str(spec) != "" else None
    if wanted is not None and wanted.isdigit():
        try:
            dev = sd.query_devices(int(wanted))
        except Exception:  # bad index / PortAudio error
            return None
        return (int(wanted), dev) if dev.get("max_input_channels", 0) > 0 else None
    text = (wanted or needle or "").lower()
    if not text:
        return None
    for idx, dev in enumerate(sd.query_devices()):
        if dev.get("max_input_channels", 0) > 0 and text in dev["name"].lower():
            return idx, dev
    return None


def _pump_input_device(out: "queue.Queue[tuple[int, np.ndarray]]",
                       stop: threading.Event, ready: threading.Event,
                       idx: int, dev: dict, label: str) -> None:
    """Open a sounddevice input (stereo downmixed to mono) until `stop` is set."""
    sd = _sounddevice()
    rate = int(dev.get("default_samplerate") or 48000)
    channels = int(min(2, dev.get("max_input_channels", 1))) or 1
    blocksize = int(rate * BLOCK_SECONDS)
    log.info(
        "%s: opening %r (index %s, %d Hz, %d ch)",
        label, dev["name"], idx, rate, channels,
    )

    def callback(indata, frames, time_info, status):  # type: ignore[no-untyped-def]
        if status:
            log.debug("%s: %s", label, status)
        block = indata[:, 0].copy() if channels == 1 \
            else indata.mean(axis=1, dtype=np.float32).copy()
        _push(out, rate, block)

    with sd.InputStream(
        device=idx, samplerate=rate, channels=channels, dtype="float32",
        blocksize=blocksize, callback=callback,
    ):
        ready.set()
        stop.wait()


class SoundDeviceSystemSource(threading.Thread):
    """macOS: system audio from a loopback input device (BlackHole) via sounddevice.

    CoreAudio cannot tap the output, so the user routes it into a virtual
    loopback input; `device` (index or name substring) overrides the search
    for `default_name`."""

    def __init__(self, out: "queue.Queue[tuple[int, np.ndarray]]",
                 stop: threading.Event, device: str | int | None = None,
                 default_name: str = MACOS_LOOPBACK_NAME) -> None:
        super().__init__(name="system-source", daemon=True)
        self.out = out
        self.stop_event = stop
        self.device = device
        self.default_name = default_name
        self.ready = threading.Event()
        self.error: Exception | None = None

    def run(self) -> None:
        try:
            self._run_stream()
        except Exception as exc:  # thread boundary: surface to AudioFeeds
            self.error = exc
            log.error("system capture failed: %s", exc)
        finally:
            self.ready.set()

    def _run_stream(self) -> None:
        found = _find_input_device(_sounddevice(), self.device, self.default_name)
        if found is None:
            raise AudioDeviceError(self._missing_message())
        _pump_input_device(self.out, self.stop_event, self.ready, *found,
                           label="system")

    def _missing_message(self) -> str:
        if self.device not in (None, ""):
            return (
                f"no input device matching --system-device {self.device!r}; "
                "run `python -m sounddevice` to list the input devices"
            )
        return (
            f"no {self.default_name} loopback input device found. To capture the "
            f"meeting audio on macOS: install {self.default_name} 2ch "
            "(`brew install blackhole-2ch`, or from existential.audio), open "
            "Audio MIDI Setup and create a Multi-Output Device containing your "
            f"speakers/headphones plus {self.default_name} (so you still hear the "
            "meeting), and set it as the system output. Or pass "
            "`--system-device <name>` (env TASKLY_SYSTEM_DEVICE) to use another "
            "loopback input."
        )


class _ParecUnavailable(RuntimeError):
    """parec is missing or could not connect (fallback / setup help follows)."""


class LinuxSystemSource(threading.Thread):
    """Linux: `parec` on a sink monitor (PulseAudio / PipeWire-pulse).

    Default device is the default sink's monitor (`@DEFAULT_MONITOR@`), read as
    raw 16 kHz mono s16le. If parec is missing or exits at once, falls back to
    a sounddevice input whose name contains "monitor".

    `device` (index or name substring): if it matches a sounddevice input that
    input is used; otherwise it is handed to `parec --device=<value>` (a Pulse
    source name or index, e.g. from `pactl list short sources`). An explicit
    device never silently falls back to a different one."""

    def __init__(self, out: "queue.Queue[tuple[int, np.ndarray]]",
                 stop: threading.Event, device: str | int | None = None) -> None:
        super().__init__(name="system-source", daemon=True)
        self.out = out
        self.stop_event = stop
        self.device = device
        self.ready = threading.Event()
        self.error: Exception | None = None

    def run(self) -> None:
        try:
            self._run_stream()
        except Exception as exc:  # thread boundary: surface to AudioFeeds
            self.error = exc
            log.error("system capture failed: %s", exc)
        finally:
            self.ready.set()

    def _run_stream(self) -> None:
        if self.device not in (None, ""):
            found = self._sounddevice_match(self.device, None)
            if found is not None:
                _pump_input_device(self.out, self.stop_event, self.ready, *found,
                                   label="system")
                return
            try:
                self._run_parec(str(self.device))
            except _ParecUnavailable as exc:
                raise AudioDeviceError(
                    f"--system-device {self.device!r} matches no sounddevice input "
                    f"and parec could not open it ({exc}). {self._help()}"
                ) from exc
            return
        try:
            self._run_parec(LINUX_DEFAULT_MONITOR)
            return
        except _ParecUnavailable as exc:
            log.warning("parec unavailable (%s); trying a monitor input device", exc)
            parec_reason = str(exc)
        found = self._sounddevice_match(None, "monitor")
        if found is None:
            raise AudioDeviceError(
                f"no system-audio monitor available (parec: {parec_reason}; no "
                f"sounddevice input named like 'monitor'). {self._help()}"
            )
        _pump_input_device(self.out, self.stop_event, self.ready, *found,
                           label="system")

    @staticmethod
    def _help() -> str:
        return (
            "Install parec with `sudo apt install pulseaudio-utils` (PipeWire: "
            "also `pipewire-pulse`) and make sure a sound server is running, or "
            "pass `--system-device <name>` (env TASKLY_SYSTEM_DEVICE) naming a "
            "monitor source (see `pactl list short sources`)."
        )

    @staticmethod
    def _sounddevice_match(spec: str | int | None,
                           needle: str | None) -> tuple[int, dict] | None:
        try:
            return _find_input_device(_sounddevice(), spec, needle)
        except AudioDeviceError as exc:  # PortAudio missing: parec-only host
            log.debug("sounddevice lookup skipped: %s", exc)
            return None

    def _run_parec(self, device: str) -> None:
        exe = shutil.which("parec")
        if exe is None:
            raise _ParecUnavailable("parec not found on PATH")
        argv = [exe, f"--device={device}", f"--rate={TARGET_RATE}", "--channels=1",
                "--format=s16le", "--raw"]
        try:
            proc = subprocess.Popen(
                argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:  # FileNotFoundError, permissions, ...
            raise _ParecUnavailable(f"cannot start parec: {exc}") from exc
        done = threading.Event()
        try:
            try:
                code = proc.wait(timeout=PAREC_SETTLE_SECONDS)
            except subprocess.TimeoutExpired:
                pass  # still running after the settle time: it connected
            else:
                detail = ""
                try:
                    detail = proc.stderr.read().decode("utf-8", "replace").strip()
                except Exception:  # noqa: S110 - diagnostics only
                    pass
                raise _ParecUnavailable(
                    f"parec exited immediately (code {code})"
                    + (f": {detail[:200]}" if detail else "")
                )
            log.info("system: parec on %r (%d Hz, mono)", device, TARGET_RATE)
            threading.Thread(
                target=self._terminate_on_stop, args=(proc, done),
                name="system-parec-reaper", daemon=True,
            ).start()
            self.ready.set()
            self._read_loop(proc)
        finally:
            done.set()
            _terminate(proc)

    def _terminate_on_stop(self, proc: Any, done: threading.Event) -> None:
        """Unblock the reader: terminating parec makes stdout hit end-of-file."""
        while not done.is_set():
            if self.stop_event.wait(0.1):
                _terminate(proc)
                return

    def _read_loop(self, proc: Any) -> None:
        nbytes = int(TARGET_RATE * BLOCK_SECONDS) * 2  # s16le mono
        pending = b""
        while not self.stop_event.is_set():
            data = proc.stdout.read(nbytes)
            if not data:
                break  # end of stream: stopped, or parec died
            pending += data
            usable = len(pending) - (len(pending) % 2)
            if not usable:
                continue
            samples = np.frombuffer(pending[:usable], dtype="<i2")
            pending = pending[usable:]
            _push(self.out, TARGET_RATE, samples.astype(np.float32) / 32768.0)
        if not self.stop_event.is_set():
            raise AudioDeviceError("parec exited unexpectedly while capturing")


def _terminate(proc: Any) -> None:
    """Stop a subprocess politely, killing it if it ignores terminate()."""
    try:
        proc.terminate()
        proc.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:  # pragma: no cover
            pass
    except OSError:  # already gone
        pass


def _system_source_for(platform: str, out: "queue.Queue[tuple[int, np.ndarray]]",
                       stop: threading.Event,
                       system_device: str | int | None = None) -> Any:
    """Pick the system-audio source for an OS (a `sys.platform` value).

    Every returned thread exposes `ready` (Event, set once startup succeeded
    or failed) and `error` (Exception | None), which `AudioFeeds._start_system`
    relies on."""
    if platform == "win32":
        return SystemLoopbackSource(out, stop, device=system_device)
    if platform == "darwin":
        return SoundDeviceSystemSource(out, stop, device=system_device)
    return LinuxSystemSource(out, stop, device=system_device)


class AudioFeeds:
    """Owns the requested sources, their worker threads, and their stop event."""

    def __init__(
        self,
        on_chunk: ChunkCallback,
        *,
        mic: bool = True,
        system: bool = True,
        device: str | None = None,
        auto_gain: bool = True,
        system_device: str | None = None,
    ) -> None:
        self.on_chunk = on_chunk
        self.want_mic = mic
        self.want_system = system
        self.device = device
        self.system_device = system_device  # loopback/monitor: index or name
        self.auto_gain = auto_gain
        self.stop_event = threading.Event()
        self.sources: list[threading.Thread] = []
        self.workers: list[_Worker] = []
        self.stats: dict[str, SourceStats] = {}

    def start(self) -> None:
        """Start requested sources; at least one must come up."""
        errors: list[tuple[str, Exception]] = []
        if self.want_mic:
            self._start_mic(errors)
        if self.want_system:
            self._start_system(errors)

        if not self.workers:
            detail = "; ".join(f"{src}: {err}" for src, err in errors) or \
                "no audio sources requested"
            self.stop_event.set()
            raise AudioDeviceError(
                f"no audio source available ({detail})"
            )
        for src, err in errors:  # partial success: keep going, warn loudly
            log.warning("continuing without %s: %s", src, err)

    def _start_mic(self, errors: list[tuple[str, Exception]]) -> None:
        q: "queue.Queue[tuple[int, np.ndarray]]" = queue.Queue(maxsize=QUEUE_BLOCKS)
        src = MicSource(q, self.device, self.stop_event)
        src.start()
        src.ready.wait(5.0)
        if src.error is not None:
            errors.append((SOURCE_MIC, src.error))
            return
        if not src.ready.is_set():
            errors.append((SOURCE_MIC, TimeoutError("InputStream did not open")))
            return
        worker = _Worker(SOURCE_MIC, q, self.on_chunk, auto_gain=self.auto_gain,
                         boost_ok=True)
        worker.start()
        self.workers.append(worker)
        self.stats[SOURCE_MIC] = worker.stats
        self.sources.append(src)

    def _start_system(self, errors: list[tuple[str, Exception]]) -> None:
        q: "queue.Queue[tuple[int, np.ndarray]]" = queue.Queue(maxsize=QUEUE_BLOCKS)
        src = _system_source_for(sys.platform, q, self.stop_event,
                                 self.system_device)
        src.start()
        src.ready.wait(8.0)
        if src.error is not None:
            errors.append((SOURCE_SYSTEM, src.error))
            return
        if not src.ready.is_set():
            errors.append((SOURCE_SYSTEM, TimeoutError("system audio did not open")))
            return
        worker = _Worker(SOURCE_SYSTEM, q, self.on_chunk,
                         auto_gain=self.auto_gain, boost_ok=False)
        worker.start()
        self.workers.append(worker)
        self.stats[SOURCE_SYSTEM] = worker.stats
        self.sources.append(src)

    def stop(self) -> None:
        self.stop_event.set()
        for src in self.sources:
            try:
                src.join(timeout=2.0)
            except RuntimeError:  # already stopped
                pass
        for worker in self.workers:
            worker.join(timeout=2.0)
