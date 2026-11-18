"""Reproducible loopback TLS/auth smoke for Neyra's real FastAPI routes.

Uses disposable tokens, a temporary self-signed certificate, and non-model stub
services. It never sends a chat message or calls an external provider.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import uvicorn

from core.api.app import build_app  # noqa: E402
from core.runtime.event_bus import EventBus  # noqa: E402


class _Monitor:
    def start(self) -> None:
        pass

    async def run_once(self):
        return {"ok": True, "status": "ok"}


class _Backup:
    def run_backup(self, *_args, **_kwargs):
        raise AssertionError("backup endpoint is outside this smoke")

    def list_backups(self):
        return []

    def read_last_apply_result(self):
        return None


class _Agent:
    def __init__(self):
        self.event_bus = EventBus()
        self.memory_hub = None

    async def start_mcp_clients(self):
        return None

    async def stop_mcp_clients(self):
        return None


def _port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _ws_handshake(port: int, context: ssl.SSLContext, token: str | None) -> tuple[int, dict | None]:
    raw = socket.create_connection(("127.0.0.1", port), timeout=5)
    with context.wrap_socket(raw, server_hostname="localhost") as conn:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        auth = f"Authorization: Bearer {token}\r\n" if token else ""
        request = (
            "GET /v1/ws/chat HTTP/1.1\r\n"
            f"Host: localhost:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Key: {key}\r\n{auth}\r\n"
        )
        conn.sendall(request.encode("ascii"))
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = conn.recv(1)
            if not chunk:
                raise RuntimeError("WebSocket handshake ended without an HTTP response")
            response += chunk
        status = int(response.split(b" ", 2)[1])
        if status != 101:
            return status, None
        first = conn.recv(2)
        if len(first) != 2:
            raise RuntimeError("WebSocket server did not send its greeting")
        length = first[1] & 0x7F
        if length == 126:
            length = int.from_bytes(conn.recv(2), "big")
        elif length == 127:
            length = int.from_bytes(conn.recv(8), "big")
        payload = b""
        while len(payload) < length:
            payload += conn.recv(length - len(payload))
        return status, json.loads(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-workdir", type=Path,
                        help="optional empty directory for the temporary cert and server state")
    args = parser.parse_args()
    if args.keep_workdir:
        work = args.keep_workdir.expanduser().resolve()
        work.mkdir(parents=True, exist_ok=True)
        if any(work.iterdir()):
            parser.error("--keep-workdir must be empty")
        cleanup = None
    else:
        cleanup = tempfile.TemporaryDirectory(prefix="neyra-pr65-tls-smoke-")
        work = Path(cleanup.name)

    try:
        cert, key = work / "localhost.crt", work / "localhost.key"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-keyout", str(key), "-out", str(cert), "-subj", "/CN=localhost",
             "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        (work / "state").mkdir()
        config = {
            "api": {"host": "127.0.0.1", "port": 0, "auth_required": True,
                    "token": "pr65-smoke-admin", "viewer_token": "pr65-smoke-viewer",
                    "state_dir": str(work / "state"), "audit_log_enabled": False,
                    "rate_limit_requests_per_minute": 0},
            "dashboard": {"enabled": False},
        }
        agent = _Agent()
        app = build_app(config, shared_agent=agent, shared_monitor=_Monitor(),
                        shared_backup_manager=_Backup(), project_root=work)
        port = _port()
        server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=port, ssl_certfile=str(cert),
            ssl_keyfile=str(key), log_level="error", access_log=False,
        ))
        thread = threading.Thread(target=server.run, name="pr65-tls-smoke", daemon=True)
        thread.start()
        context = ssl.create_default_context(cafile=str(cert))
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if server.started:
                    break
                if not thread.is_alive():
                    raise RuntimeError("Uvicorn exited before startup")
                time.sleep(0.05)
            if not server.started:
                raise TimeoutError("temporary Uvicorn did not start")
            base = f"https://localhost:{port}"
            with httpx.Client(verify=context, timeout=5) as client:
                live = client.get(base + "/v1/health/live").status_code
                unauth_ready = client.get(base + "/v1/health/ready").status_code
                ready = client.get(base + "/v1/health/ready",
                                   headers={"Authorization": "Bearer pr65-smoke-viewer"}).status_code
            if (live, unauth_ready, ready) != (200, 401, 200):
                raise RuntimeError(f"unexpected HTTPS status tuple: {(live, unauth_ready, ready)}")
            denied, _ = _ws_handshake(port, context, None)
            accepted, greeting = _ws_handshake(port, context, "pr65-smoke-admin")
            if denied == 101 or accepted != 101 or (greeting or {}).get("protocol") != "neyra.ws.chat.v1":
                raise RuntimeError("WSS authentication or greeting check failed")
            print(f"PASS https={live}/{unauth_ready}/{ready} wss=unauthorized:{denied},admin:{accepted}")
        finally:
            server.should_exit = True
            thread.join(timeout=5)
            if thread.is_alive():
                raise TimeoutError("temporary Uvicorn did not stop")
    finally:
        if cleanup is not None:
            cleanup.cleanup()
        else:
            print("Temporary certificate and server state retained in the caller's work directory.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
