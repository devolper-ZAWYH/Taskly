"""Taskly Live — local capture engine for real-time meeting minutes.

Python prototype of the desktop engine box in plan-live-meetings §3:
mic + WASAPI-loopback capture, per-source VAD segmentation, faster-whisper
(auto-language transcribe + translate->EN), SQLite append-before-send
journal, and an idempotent batched pusher over the `/api/live/*` contract.

Audio never leaves the machine; only text segments are pushed.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
