"""Per-OS system-audio source selection, with every device mocked out.

No audio hardware, PortAudio, PulseAudio or WASAPI is touched: `sounddevice`,
`pyaudiowpatch` and `subprocess.Popen` (parec) are replaced by fakes.
"""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import queue
import subprocess
import sys
import threading
import types
from pathlib import Path

import numpy as np
import pytest

from taskly_live import audio
from taskly_live.audio import (
    AudioDeviceError,
    AudioFeeds,
    LinuxSystemSource,
    SOURCE_SYSTEM,
    SoundDeviceSystemSource,
    SystemLoopbackSource,
    _system_source_for,
)

ENGINE_ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# fakes
# --------------------------------------------------------------------------

def dev(name: str, inputs: int = 2, rate: float = 48000.0) -> dict:
    return {"name": name, "max_input_channels": inputs, "default_samplerate": rate}


class FakeSD(types.ModuleType):
    """Stand-in for the `sounddevice` module (query_devices + InputStream)."""

    def __init__(self, devices: list[dict]) -> None:
        super().__init__("sounddevice")
        self.devices = devices
        self.streams: list["FakeSD.InputStream"] = []
        outer = self

        class InputStream:
            def __init__(self, **kwargs) -> None:  # type: ignore[no-untyped-def]
                self.kwargs = kwargs
                self.opened = threading.Event()
                outer.streams.append(self)

            def __enter__(self) -> "InputStream":
                self.opened.set()
                return self

            def __exit__(self, *exc) -> None:  # type: ignore[no-untyped-def]
                return None

        self.InputStream = InputStream

    def query_devices(self, index: int | None = None):  # type: ignore[no-untyped-def]
        if index is None:
            return list(self.devices)
        return self.devices[index]


def install_sd(monkeypatch: pytest.MonkeyPatch, devices: list[dict]) -> FakeSD:
    fake = FakeSD(devices)
    monkeypatch.setitem(sys.modules, "sounddevice", fake)
    return fake


def run_source(src) -> None:  # type: ignore[no-untyped-def]
    """Run a source's startup synchronously (no thread)."""
    src.run()


def start_and_wait(src) -> None:  # type: ignore[no-untyped-def]
    src.start()
    assert src.ready.wait(3.0), "source never signalled ready"


def stop_source(stop: threading.Event, src) -> None:  # type: ignore[no-untyped-def]
    stop.set()
    src.join(timeout=3.0)
    assert not src.is_alive()


def new_queue() -> "queue.Queue[tuple[int, np.ndarray]]":
    return queue.Queue(maxsize=audio.QUEUE_BLOCKS)


class FakeStdout:
    """Pipe-like stdout: yields chunks, then blocks until the process stops."""

    def __init__(self, proc: "FakeProc", chunks: list[bytes], eof_after: bool) -> None:
        self.proc = proc
        self.chunks = list(chunks)
        self.eof_after = eof_after

    def read(self, n: int) -> bytes:
        if self.chunks:
            return self.chunks.pop(0)
        if self.eof_after:
            return b""
        self.proc.stopped.wait(5.0)  # parec keeps streaming until terminated
        return b""


class FakeProc:
    def __init__(self, argv: list[str], *, chunks: list[bytes] | None = None,
                 exit_code: int | None = None, stderr: bytes = b"",
                 eof_after: bool = False) -> None:
        self.argv = argv
        self.exit_code = exit_code
        self.terminate_calls = 0
        self.kill_calls = 0
        self.stopped = threading.Event()
        self.stdout = FakeStdout(self, chunks or [], eof_after)
        self.stderr = types.SimpleNamespace(read=lambda: stderr)
        if exit_code is not None:
            self.stopped.set()

    def wait(self, timeout: float | None = None) -> int:
        if self.exit_code is not None:
            return self.exit_code
        if self.stopped.wait(timeout):
            self.exit_code = -15
            return self.exit_code
        raise subprocess.TimeoutExpired(self.argv, timeout or 0)

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.stopped.set()

    def kill(self) -> None:  # pragma: no cover - only on a stuck parec
        self.kill_calls += 1
        self.stopped.set()


class PopenRecorder:
    def __init__(self, **proc_kwargs) -> None:  # type: ignore[no-untyped-def]
        self.proc_kwargs = proc_kwargs
        self.procs: list[FakeProc] = []

    def __call__(self, argv, **kwargs):  # type: ignore[no-untyped-def]
        proc = FakeProc(list(argv), **self.proc_kwargs)
        self.procs.append(proc)
        return proc


def fake_parec(monkeypatch: pytest.MonkeyPatch, **proc_kwargs) -> PopenRecorder:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(audio, "PAREC_SETTLE_SECONDS", 0.02)
    monkeypatch.setattr(audio.shutil, "which", lambda name: f"/usr/bin/{name}")
    popen = PopenRecorder(**proc_kwargs)
    monkeypatch.setattr(audio.subprocess, "Popen", popen)
    return popen


def pcm(*samples: int) -> bytes:
    return np.array(samples, dtype="<i2").tobytes()


# --------------------------------------------------------------------------
# import hygiene + factory
# --------------------------------------------------------------------------

def test_import_does_not_pull_platform_libraries() -> None:
    # Fresh interpreter: nothing earlier in this session can mask an import.
    code = (
        "import sys, taskly_live.audio;"
        "bad = [m for m in ('pyaudiowpatch', 'sounddevice') if m in sys.modules];"
        "sys.exit(1 if bad else 0)"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], cwd=ENGINE_ROOT, capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stderr


def test_fresh_load_does_not_import_pyaudiowpatch(
        monkeypatch: pytest.MonkeyPatch) -> None:
    # Execute the module source again under a private name (a plain
    # importlib.reload would swap the classes the other tests hold).
    monkeypatch.delitem(sys.modules, "pyaudiowpatch", raising=False)
    spec = importlib.util.spec_from_file_location("_audio_fresh", audio.__file__)
    assert spec is not None and spec.loader is not None
    fresh = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "_audio_fresh", fresh)  # dataclasses needs it
    spec.loader.exec_module(fresh)
    assert "pyaudiowpatch" not in sys.modules


def test_factory_picks_source_by_platform() -> None:
    q, stop = new_queue(), threading.Event()
    assert isinstance(_system_source_for("win32", q, stop), SystemLoopbackSource)
    assert isinstance(_system_source_for("darwin", q, stop), SoundDeviceSystemSource)
    assert isinstance(_system_source_for("linux", q, stop), LinuxSystemSource)
    assert isinstance(_system_source_for("freebsd13", q, stop), LinuxSystemSource)


def test_factory_passes_system_device() -> None:
    q, stop = new_queue(), threading.Event()
    for platform in ("win32", "darwin", "linux"):
        src = _system_source_for(platform, q, stop, "Some Device")
        assert src.device == "Some Device"
        assert hasattr(src, "ready") and hasattr(src, "error")


def test_audiofeeds_accepts_system_device_keyword() -> None:
    params = inspect.signature(AudioFeeds.__init__).parameters
    assert params["system_device"].kind is inspect.Parameter.KEYWORD_ONLY
    assert params["system_device"].default is None
    feeds = AudioFeeds(lambda s, c: None, system_device="BlackHole 16ch")
    assert feeds.system_device == "BlackHole 16ch"


# --------------------------------------------------------------------------
# macOS: BlackHole through sounddevice
# --------------------------------------------------------------------------

def test_macos_missing_blackhole_raises_actionable_error(
        monkeypatch: pytest.MonkeyPatch) -> None:
    install_sd(monkeypatch, [dev("MacBook Pro Microphone", 1), dev("Speakers", 0)])
    src = _system_source_for("darwin", new_queue(), threading.Event())
    run_source(src)
    assert isinstance(src.error, AudioDeviceError)
    msg = str(src.error)
    assert "BlackHole" in msg
    assert "brew install blackhole-2ch" in msg
    assert "Multi-Output" in msg
    assert "--system-device" in msg and "TASKLY_SYSTEM_DEVICE" in msg
    assert src.ready.is_set()  # AudioFeeds must never wait out the timeout


def test_macos_finds_blackhole_and_streams(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(
        monkeypatch,
        [dev("MacBook Pro Microphone", 1), dev("BlackHole 2ch", 2, 44100.0),
         dev("External Headphones", 0)],
    )
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("darwin", q, stop)
    start_and_wait(src)
    stream = fake.streams[0]
    assert stream.kwargs["device"] == 1
    assert stream.kwargs["samplerate"] == 44100
    assert stream.kwargs["channels"] == 2
    assert stream.kwargs["blocksize"] == int(44100 * audio.BLOCK_SECONDS)
    assert src.error is None

    # Feed one stereo block through the PortAudio callback: downmixed to mono.
    indata = np.array([[0.5, -0.5], [1.0, 0.0]], dtype=np.float32)
    stream.kwargs["callback"](indata, 2, None, None)
    rate, block = q.get_nowait()
    assert rate == 44100
    assert block.dtype == np.float32
    np.testing.assert_allclose(block, [0.0, 0.5])
    stop_source(stop, src)


def test_macos_system_device_by_name_overrides_default(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(
        monkeypatch,
        [dev("BlackHole 2ch"), dev("Loopback Audio", 2), dev("Speakers", 0)],
    )
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("darwin", q, stop, "loopback")
    start_and_wait(src)
    assert fake.streams[0].kwargs["device"] == 1  # not BlackHole at index 0
    stop_source(stop, src)


def test_macos_system_device_by_index(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(monkeypatch, [dev("BlackHole 2ch"), dev("Other Input", 1)])
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("darwin", q, stop, "1")
    start_and_wait(src)
    assert fake.streams[0].kwargs["device"] == 1
    stop_source(stop, src)


def test_macos_system_device_without_match_names_the_flag(
        monkeypatch: pytest.MonkeyPatch) -> None:
    install_sd(monkeypatch, [dev("BlackHole 2ch"), dev("Speakers", 0)])
    for spec in ("nonexistent", "1", "99"):  # no name / output-only / bad index
        src = _system_source_for("darwin", new_queue(), threading.Event(), spec)
        run_source(src)
        assert isinstance(src.error, AudioDeviceError), spec
        assert "--system-device" in str(src.error)
        assert repr(spec) in str(src.error)


def test_audiofeeds_macos_system_worker_attenuates_only(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(monkeypatch, [dev("BlackHole 2ch", 2, 16000.0)])
    monkeypatch.setattr(sys, "platform", "darwin")
    got: list[tuple[str, np.ndarray]] = []
    delivered = threading.Event()

    def on_chunk(source: str, chunk: np.ndarray) -> None:
        got.append((source, chunk))
        delivered.set()

    feeds = AudioFeeds(on_chunk, mic=False, system=True)
    feeds.start()
    try:
        assert [w.source for w in feeds.workers] == [SOURCE_SYSTEM]
        assert feeds.workers[0].boost_ok is False
        fake.streams[0].kwargs["callback"](
            np.full((1600, 2), 0.1, dtype=np.float32), 1600, None, None
        )
        assert delivered.wait(3.0)
        assert got[0][0] == SOURCE_SYSTEM
        assert got[0][1].dtype == np.float32 and got[0][1].size == 1600
    finally:
        feeds.stop()
    assert not feeds.sources[0].is_alive()


def test_audiofeeds_reports_missing_loopback_when_nothing_else(
        monkeypatch: pytest.MonkeyPatch) -> None:
    install_sd(monkeypatch, [dev("Mic", 1)])
    monkeypatch.setattr(sys, "platform", "darwin")
    feeds = AudioFeeds(lambda s, c: None, mic=False, system=True)
    with pytest.raises(AudioDeviceError, match="BlackHole"):
        feeds.start()


# --------------------------------------------------------------------------
# Linux: parec, then a "monitor" sounddevice input
# --------------------------------------------------------------------------

def test_linux_parec_argv_and_float_conversion(
        monkeypatch: pytest.MonkeyPatch) -> None:
    popen = fake_parec(
        monkeypatch, chunks=[pcm(0, 16384, -32768, 32767)],
    )
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("linux", q, stop)
    start_and_wait(src)
    assert src.error is None

    proc = popen.procs[0]
    assert proc.argv[1:] == [
        "--device=@DEFAULT_MONITOR@", "--rate=16000", "--channels=1",
        "--format=s16le", "--raw",
    ]
    rate, block = q.get(timeout=3.0)
    assert rate == 16000
    assert block.dtype == np.float32
    np.testing.assert_allclose(block, [0.0, 0.5, -1.0, 32767 / 32768.0])
    assert block.min() >= -1.0 and block.max() <= 1.0

    assert proc.terminate_calls == 0
    stop_source(stop, src)  # reader is blocked in read(): stop must unblock it
    assert proc.terminate_calls >= 1


def test_linux_parec_reassembles_split_samples(
        monkeypatch: pytest.MonkeyPatch) -> None:
    # 0x4000 then 0x8000 (little endian), delivered in 3 + 1 byte reads.
    fake_parec(monkeypatch, chunks=[b"\x00\x40\x00", b"\x80"])
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("linux", q, stop)
    start_and_wait(src)
    samples: list[float] = []
    while len(samples) < 2:
        samples.extend(q.get(timeout=3.0)[1].tolist())
    assert samples == [0.5, -1.0]
    stop_source(stop, src)


def test_linux_parec_death_after_start_is_reported(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake_parec(monkeypatch, chunks=[pcm(1, 2)], eof_after=True)
    stop = threading.Event()
    src = _system_source_for("linux", new_queue(), stop)
    src.start()
    src.join(timeout=3.0)
    assert isinstance(src.error, AudioDeviceError)
    assert "parec exited" in str(src.error)


def test_linux_parec_missing_falls_back_to_monitor_input(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(
        monkeypatch,
        [dev("Built-in Microphone", 1),
         dev("Monitor of Built-in Audio Analog Stereo", 2, 44100.0)],
    )
    monkeypatch.setattr(audio.shutil, "which", lambda name: None)

    def no_popen(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("parec must not be spawned when it is not installed")

    monkeypatch.setattr(audio.subprocess, "Popen", no_popen)
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("linux", q, stop)
    start_and_wait(src)
    assert src.error is None
    assert fake.streams[0].kwargs["device"] == 1
    assert fake.streams[0].kwargs["channels"] == 2
    stop_source(stop, src)


def test_linux_popen_filenotfound_also_falls_back(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(monkeypatch, [dev("alsa_output.monitor", 2)])
    monkeypatch.setattr(audio.shutil, "which", lambda name: "/usr/bin/parec")

    def missing(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise FileNotFoundError("parec")

    monkeypatch.setattr(audio.subprocess, "Popen", missing)
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("linux", q, stop)
    start_and_wait(src)
    assert src.error is None and fake.streams[0].kwargs["device"] == 0
    stop_source(stop, src)


def test_linux_parec_exiting_immediately_falls_back_to_monitor_input(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(monkeypatch, [dev("Mic", 1), dev("MONITOR of Speakers", 2)])
    popen = fake_parec(monkeypatch, exit_code=1, stderr=b"Connection refused")
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("linux", q, stop)
    start_and_wait(src)
    assert src.error is None
    assert len(popen.procs) == 1
    assert fake.streams[0].kwargs["device"] == 1  # case-insensitive "monitor"
    stop_source(stop, src)


def test_linux_nothing_available_gives_setup_help(
        monkeypatch: pytest.MonkeyPatch) -> None:
    install_sd(monkeypatch, [dev("Mic", 1)])
    fake_parec(monkeypatch, exit_code=1, stderr=b"Connection refused")
    src = _system_source_for("linux", new_queue(), threading.Event())
    run_source(src)
    assert isinstance(src.error, AudioDeviceError)
    msg = str(src.error)
    assert "sudo apt install pulseaudio-utils" in msg
    assert "pipewire-pulse" in msg
    assert "--system-device" in msg
    assert "Connection refused" in msg  # why parec failed


def test_linux_parec_missing_and_no_portaudio(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "sounddevice", None)  # import -> ImportError
    monkeypatch.setattr(audio.shutil, "which", lambda name: None)
    src = _system_source_for("linux", new_queue(), threading.Event())
    run_source(src)
    assert isinstance(src.error, AudioDeviceError)
    assert "pulseaudio-utils" in str(src.error)


def test_linux_parec_works_without_portaudio(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "sounddevice", None)
    fake_parec(monkeypatch, chunks=[pcm(8192, -8192)])
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("linux", q, stop)
    start_and_wait(src)
    np.testing.assert_allclose(q.get(timeout=3.0)[1], [0.25, -0.25])
    stop_source(stop, src)


def test_linux_system_device_prefers_matching_sounddevice_input(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(monkeypatch, [dev("Mic", 1), dev("Loopback Source", 2)])

    def no_popen(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("a sounddevice match must not spawn parec")

    monkeypatch.setattr(audio.subprocess, "Popen", no_popen)
    q, stop = new_queue(), threading.Event()
    src = _system_source_for("linux", q, stop, "loopback")
    start_and_wait(src)
    assert fake.streams[0].kwargs["device"] == 1
    stop_source(stop, src)


def test_linux_system_device_otherwise_goes_to_parec(
        monkeypatch: pytest.MonkeyPatch) -> None:
    install_sd(monkeypatch, [dev("Mic", 1)])
    popen = fake_parec(monkeypatch, chunks=[pcm(0, 0)])
    q, stop = new_queue(), threading.Event()
    name = "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor"
    src = _system_source_for("linux", q, stop, name)
    start_and_wait(src)
    assert popen.procs[0].argv[1] == f"--device={name}"
    stop_source(stop, src)


def test_linux_explicit_system_device_never_falls_back(
        monkeypatch: pytest.MonkeyPatch) -> None:
    fake = install_sd(monkeypatch, [dev("Some Monitor", 2)])  # would be the fallback
    fake_parec(monkeypatch, exit_code=1, stderr=b"No such entity")
    src = _system_source_for("linux", new_queue(), threading.Event(), "typo-device")
    run_source(src)
    assert isinstance(src.error, AudioDeviceError)
    assert "typo-device" in str(src.error)
    assert not fake.streams  # nothing was opened behind the user's back


# --------------------------------------------------------------------------
# Windows: lazy pyaudiowpatch, optional device selection
# --------------------------------------------------------------------------

class FakePyAudio:
    def __init__(self, loopbacks: list[dict], default: dict | None) -> None:
        self.loopbacks = loopbacks
        self.default = default

    def get_default_wasapi_loopback(self) -> dict:
        if self.default is None:
            raise OSError("no default")
        return self.default

    def get_loopback_device_info_generator(self):  # type: ignore[no-untyped-def]
        yield from self.loopbacks


LOOPBACKS = [
    {"index": 5, "name": "Speakers (Realtek) [Loopback]", "maxInputChannels": 2},
    {"index": 9, "name": "Headset (USB) [Loopback]", "maxInputChannels": 2},
]


@pytest.fixture()
def fake_pyaudiowpatch(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    mod = types.ModuleType("pyaudiowpatch")
    mod.paWASAPI = 13  # type: ignore[attr-defined]
    mod.paInt16 = 8  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pyaudiowpatch", mod)
    return mod


def test_windows_default_loopback_is_unchanged(
        fake_pyaudiowpatch: types.ModuleType) -> None:
    pa = FakePyAudio(LOOPBACKS, default=LOOPBACKS[0])
    assert SystemLoopbackSource._find_loopback(pa)["index"] == 5
    assert SystemLoopbackSource._find_loopback(pa, None)["index"] == 5


def test_windows_system_device_by_name_and_index(
        fake_pyaudiowpatch: types.ModuleType) -> None:
    pa = FakePyAudio(LOOPBACKS, default=LOOPBACKS[0])
    assert SystemLoopbackSource._find_loopback(pa, "headset")["index"] == 9
    assert SystemLoopbackSource._find_loopback(pa, "9")["index"] == 9


def test_windows_unknown_system_device_lists_choices(
        fake_pyaudiowpatch: types.ModuleType) -> None:
    pa = FakePyAudio(LOOPBACKS, default=LOOPBACKS[0])
    with pytest.raises(AudioDeviceError, match="Headset"):
        SystemLoopbackSource._find_loopback(pa, "bluetooth")


def test_windows_missing_pyaudiowpatch_is_an_audio_error(
        monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "pyaudiowpatch", None)
    src = _system_source_for("win32", new_queue(), threading.Event())
    run_source(src)
    assert isinstance(src.error, AudioDeviceError)
    assert "PyAudioWPatch" in str(src.error)
    assert src.ready.is_set()
