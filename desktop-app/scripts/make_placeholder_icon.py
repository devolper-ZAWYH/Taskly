"""Writes a flat-color 1024x1024 RGBA PNG using only the Python standard library.

Purpose: give `cargo tauri icon` something to run on before the real Taskly
brand PNG is rendered from public/brand/taskly.svg (which stays in the
desktop repo). The placeholder uses the brand's green/navy palette; it is NOT
the shipped artwork — replace it and re-run icon generation before release.

Replace + regenerate with:
    cargo tauri icon src-tauri/icons/source/app-icon-1024.png
"""

import pathlib
import struct
import zlib

SIZE = 1024
OUT = (
    pathlib.Path(__file__).resolve().parents[1]
    / "src-tauri"
    / "icons"
    / "source"
    / "app-icon-1024.png"
)

TOP = (0x0B, 0x53, 0x45)  # brand green #0B5345
BOTTOM = (0x1F, 0x2A, 0x56)  # brand navy #1F2A56


def chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def main() -> int:
    rows: list[bytes] = []
    for y in range(SIZE):
        t = y / (SIZE - 1)
        pixel = tuple(
            round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)
        )
        rows.append(b"\x00" + bytes(pixel + (255,)) * SIZE)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(
        b"IHDR",
        struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0),  # RGBA, no interlace
    )
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    png += chunk(b"IEND", b"")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(png)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
