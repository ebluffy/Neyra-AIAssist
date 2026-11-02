#!/usr/bin/env python3
"""Real loopback HTTPS/WSS Control API smoke with deterministic offline dependencies."""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import types
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def serve(work: Path) -> None:
    # Never import the production agent: it can initialize providers and real memory.
    sys.path.insert(0, str(ROOT / "server"))
    for module, symbol in (
        ("core.neyra", "NeyraAgent"),
        ("core.runtime.health", "HealthMonitor"),
        ("core.reflection", "ReflectionEngine"),
    ):
        stub = types.ModuleType(module)
        setattr(stub, symbol, type(symbol, (), {}))
        sys.modules[module] = stub

    # Defense in depth for Python socket users; this is not an OS network sandbox.
    def no_network(*_args, **_kwargs):
        raise RuntimeError("Outbound network is forbidden in the offline smoke")

    socket.socket.connect = no_network
    socket.socket.connect_ex = no_network
    socket.create_connection = no_network
    socket.getaddrinfo = no_network

    import uvicorn
    from fastapi import FastAPI
    from core.api.app import build_app
    from core.runtime.event_bus import EventBus

    class Agent:
        memory_hub = None

        def __init__(self, config):
            self.config = config
            self.event_bus = EventBus()

        async def initialize(self):
            pass

        async def start_mcp_clients(self):
            pass

        async def shutdown(self):
            pass

        async def chat(self, user_message, **_kwargs):
            return {"text": f"offline:{user_message}", "sounds": [], "thoughts": ""}

        async def chat_stream(self, user_message, **_kwargs):
            yield {"type": "token", "text": "offline:"}
            yield {"type": "token", "text": user_message}
            yield {"type": "done", "text": f"offline:{user_message}"}

    class Monitor:
        last_report = {"summary": "offline", "checks": []}

        def start(self):
            pass

        async def run_once(self):
            return self.last_report

    config = {
        "api": {
            "auth_required": True,
            "token": os.environ["API_TOKEN"],
            "state_dir": str(work / "data"),
            "public_path_prefix": "/api",
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 0,
        },
        "dashboard": {"enabled": False},
        "backup": {"local_dir": str(work / "backups")},
        "memory": {"mood": {"enabled": False}},
    }
    class BackupManager:
        pass

    api = build_app(
        config,
        shared_agent=Agent(config),
        shared_monitor=Monitor(),
        shared_backup_manager=BackupManager(),
        project_root=work,
    )
    # Reproduce the production proxy's /api prefix without adding an external proxy.
    app = FastAPI(lifespan=api.router.lifespan_context)
    app.mount("/api", api)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        (work / "port.json").write_text(json.dumps(port), encoding="utf-8")
        server = uvicorn.Server(uvicorn.Config(
            app,
            ssl_certfile=str(work / "cert.pem"),
            ssl_keyfile=str(work / "key.pem"),
            log_level="warning",
            access_log=False,
            timeout_graceful_shutdown=3,
        ))
        server.run(sockets=[listener])


def stop_server(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def wait_ready(process, work: Path, timeout: float, token: str) -> int:
    deadline = time.monotonic() + timeout
    context = ssl.create_default_context(cafile=str(work / "cert.pem"))
    # Explicitly ignore proxy settings inherited by the caller.
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context),
    )
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Server exited before readiness ({process.returncode})")
        try:
            port = json.loads((work / "port.json").read_text(encoding="utf-8"))
            request = urllib.request.Request(
                f"https://127.0.0.1:{port}/api/v1/health",
                headers={"Authorization": f"Bearer {token}"},
            )
            with opener.open(request, timeout=min(1, max(0.01, deadline - time.monotonic()))) as response:
                if response.status == 200:
                    return port
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.05)
    raise TimeoutError("Control API readiness timed out")


@contextlib.contextmanager
def interrupt_cleanup():
    def interrupted(signum, _frame):
        raise InterruptedError(f"Smoke interrupted by signal {signum}")

    previous = {}
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, interrupted)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def smoke(timeout: float) -> None:
    with interrupt_cleanup(), tempfile.TemporaryDirectory(prefix=".control-api-smoke-") as directory:
        work = Path(directory)
        # No inherited API/provider keys, real config, proxy settings or home data.
        token = secrets.token_urlsafe(32)
        env = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": str(work),
            "TMPDIR": str(work),
            "PYTHONDONTWRITEBYTECODE": "1",
            "API_TOKEN": token,
        }
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(work / "key.pem"), "-out", str(work / "cert.pem"),
            "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ], check=True, capture_output=True, timeout=timeout, env=env, cwd=work)
        with (work / "server.log").open("w+", encoding="utf-8") as log:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--serve", str(work)],
                cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                # Readiness uses the same ephemeral token, without exposing it in argv.
                port = wait_ready(process, work, timeout, token)
                subprocess.run(
                    ["node", str(ROOT / "client/scripts/smoke-control-api.mjs")],
                    env={**env, "SMOKE_URL": f"https://127.0.0.1:{port}/api",
                         "NODE_EXTRA_CA_CERTS": str(work / "cert.pem")},
                    cwd=work,
                    check=True,
                    timeout=timeout,
                )
                if process.poll() is not None:
                    raise RuntimeError("Server stopped unexpectedly during the smoke")
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read().replace(token, "[redacted]"), file=sys.stderr)
                raise
            finally:
                stop_server(process)
        # Uvicorn re-raises SIGTERM after graceful shutdown on recent versions.
        if process.returncode not in (0, -signal.SIGTERM):
            raise RuntimeError(f"Server did not shut down cleanly ({process.returncode})")
    print("Offline Control API smoke: PASS (HTTPS, auth, REST chat, legacy WSS, desktop bridge; cleaned up)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=30, help="Timeout per stage in seconds (default: 30)")
    parser.add_argument("--serve", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    if args.serve:
        serve(args.serve)
        return 0
    try:
        smoke(args.timeout)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"Offline Control API smoke: FAIL ({exc})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
