"""Headless Chrome check of the VRM overlay renderer with the synthetic test model.

Needs google-chrome and Node. Run from client/: python tests/overlay_smoke.py
Software WebGL (SwiftShader) is enough; this proves loading, animation tick,
expression writes and a transparent background, not GPU speed or a real compositor.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib

PORT = 1431
URL = f"http://127.0.0.1:{PORT}/tests/overlay-harness.html"
CHROME = ["google-chrome-stable", "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--user-data-dir=" + tempfile.mkdtemp(), "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--default-background-color=00000000",
          "--window-size=320,480", "--virtual-time-budget=6000", "--timeout=6000"]


def png_alpha_stats(path):
    data = open(path, "rb").read()
    pos, width, height, idat = 8, 0, 0, b""
    while pos < len(data):
        size, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + size]
        if kind == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", body[:10])
            assert depth == 8 and color == 6, "expected 8-bit RGBA"
        elif kind == b"IDAT":
            idat += body
        pos += 12 + size
    raw, stride, prev, opaque, total = zlib.decompress(idat), width * 4, bytearray(width * 4), 0, 0
    for row in range(height):
        start = row * (stride + 1)
        filt, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            b = prev[i]
            c = prev[i - 4] if i >= 4 else 0
            if filt == 1: line[i] = (line[i] + a) & 255
            elif filt == 2: line[i] = (line[i] + b) & 255
            elif filt == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif filt == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        for i in range(3, stride, 4):
            total += 1
            opaque += line[i] > 0
        prev = line
    return opaque, total


def main():
    server = subprocess.Popen(["npx", "vite", "--port", str(PORT), "--strictPort", "--host", "127.0.0.1"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(URL, timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        dom = subprocess.run(CHROME + ["--dump-dom", URL], capture_output=True, text=True, timeout=120).stdout
        title = dom.split("<title>")[1].split("</title>")[0]
        stats = json.loads(title.replace("&quot;", '"'))
        print("renderer:", stats)
        assert stats.get("ok"), stats
        shot = os.path.join(tempfile.mkdtemp(), "overlay.png")
        subprocess.run(CHROME + [f"--screenshot={shot}", URL], capture_output=True, timeout=120)
        opaque, total = png_alpha_stats(shot)
        print(f"pixels: {opaque} drawn of {total}")
        assert 500 < opaque < total * 0.8, "model should be visible on a transparent background"
        print("overlay smoke OK")
    finally:
        server.terminate()


if __name__ == "__main__":
    sys.exit(main())
