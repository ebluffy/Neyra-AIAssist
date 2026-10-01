"""Start local Lavalink.jar when the Discord module is enabled.

Historically Lavalink was started by hand (no systemd unit). Soft-restarts of
``neyra.service`` never brought it back, so wavelink spammed connection errors.
When ``discord.music.managed_lavalink`` is true (default) and a node points at
loopback, this module ensures the JAR is listening before music preflight.
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

logger = logging.getLogger("neyra.discord.lavalink")

_LOCK = threading.Lock()
_OWNED_PROC: Optional[subprocess.Popen] = None
_OWNED_PID_FILE: Optional[Path] = None


def _music_cfg(config: dict[str, Any]) -> dict[str, Any]:
    discord = config.get("discord") if isinstance(config.get("discord"), dict) else {}
    music = discord.get("music") if isinstance(discord.get("music"), dict) else {}
    return music


def _is_loopback_host(host: str | None) -> bool:
    h = (host or "").strip().lower()
    return h in {"127.0.0.1", "localhost", "::1", "[::1]"}


def _local_node(music: dict[str, Any]) -> Optional[dict[str, Any]]:
    nodes = music.get("nodes") if isinstance(music.get("nodes"), list) else []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        uri = str(n.get("uri") or "").strip()
        if not uri:
            continue
        parsed = urlparse(uri)
        if _is_loopback_host(parsed.hostname):
            return n
    return None


def _port_open(host: str, port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _resolve_java(music: dict[str, Any]) -> Optional[str]:
    raw = str(music.get("java_path") or "").strip()
    if raw:
        p = Path(raw)
        if p.is_file():
            return str(p)
        which = shutil.which(raw)
        if which:
            return which
    return shutil.which("java")


def _lavalink_dir(plugin_dir: Path) -> Path:
    return (plugin_dir / "lavalink").resolve()


def _ensure_application_yml(lava_dir: Path) -> Path:
    yml = lava_dir / "application.yml"
    if yml.is_file():
        return yml
    example = lava_dir / "application.example.yml"
    if example.is_file():
        yml.write_bytes(example.read_bytes())
        logger.info("discord.lavalink: copied application.example.yml → application.yml")
        return yml
    raise FileNotFoundError(f"No application.yml under {lava_dir}")


def _pid_file(lava_dir: Path) -> Path:
    return lava_dir / "neyra-managed-lavalink.pid"


def _read_pid(path: Path) -> Optional[int]:
    try:
        raw = path.read_text(encoding="utf-8").strip()
        return int(raw) if raw else None
    except (OSError, ValueError):
        return None


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _wait_port(host: str, port: int, timeout_s: float) -> bool:
    deadline = time.monotonic() + max(1.0, timeout_s)
    while time.monotonic() < deadline:
        if _port_open(host, port):
            return True
        time.sleep(0.4)
    return False


def ensure_managed_lavalink(config: dict[str, Any], plugin_dir: Path) -> tuple[bool, str]:
    """Ensure local Lavalink is up when Discord music expects a loopback node.

    Returns ``(ok, detail)``. ``ok=False`` means music will likely fail until fixed.
    """
    global _OWNED_PROC, _OWNED_PID_FILE

    music = _music_cfg(config)
    if music.get("managed_lavalink", True) is False:
        return True, "managed_lavalink disabled"

    node = _local_node(music)
    if node is None:
        return True, "no loopback music node — skip managed jar"

    uri = str(node.get("uri") or "http://127.0.0.1:2333")
    parsed = urlparse(uri)
    host = parsed.hostname or "127.0.0.1"
    port = int(parsed.port or 2333)

    if _port_open(host, port):
        return True, f"already listening on {host}:{port}"

    lava_dir = _lavalink_dir(plugin_dir)
    jar = lava_dir / "Lavalink.jar"
    if not jar.is_file() or jar.stat().st_size < 1_000_000:
        return (
            False,
            f"Lavalink.jar missing/invalid at {jar} — run: python scripts/fetch_lavalink.py",
        )

    java = _resolve_java(music)
    if not java:
        return False, "java not found on PATH (install JRE 17+ or set discord.music.java_path)"

    try:
        _ensure_application_yml(lava_dir)
    except FileNotFoundError as e:
        return False, str(e)

    pid_path = _pid_file(lava_dir)
    existing = _read_pid(pid_path)
    if existing and _pid_alive(existing):
        # Process alive but port still closed — wait a bit (slow JVM boot).
        wait_s = float(music.get("managed_lavalink_ready_seconds") or 90)
        if _wait_port(host, port, min(wait_s, 45.0)):
            return True, f"existing managed pid={existing} ready on {host}:{port}"
        logger.warning(
            "discord.lavalink: pid %s alive but %s:%s not open yet — will try new start if dead later",
            existing,
            host,
            port,
        )

    log_path = lava_dir / "lavalink.log"
    wait_s = float(music.get("managed_lavalink_ready_seconds") or 90)

    with _LOCK:
        if _port_open(host, port):
            return True, f"already listening on {host}:{port}"

        try:
            log_f = open(log_path, "a", encoding="utf-8", errors="replace")
        except OSError as e:
            return False, f"cannot open {log_path}: {e}"

        try:
            # Detached session: soft-restart of Neyra must not kill Lavalink.
            creationflags = 0
            if os.name == "nt":
                creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
                    subprocess, "DETACHED_PROCESS", 0
                )
            proc = subprocess.Popen(
                [java, "-jar", str(jar)],
                cwd=str(lava_dir),
                stdout=log_f,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=(os.name != "nt"),
                creationflags=creationflags,
            )
        except OSError as e:
            log_f.close()
            return False, f"failed to spawn Lavalink: {e}"

        _OWNED_PROC = proc
        _OWNED_PID_FILE = pid_path
        try:
            pid_path.write_text(str(proc.pid), encoding="utf-8")
        except OSError:
            logger.debug("discord.lavalink: could not write pid file", exc_info=True)

        logger.info(
            "discord.lavalink: started managed process pid=%s jar=%s (log=%s)",
            proc.pid,
            jar,
            log_path,
        )

    if _wait_port(host, port, wait_s):
        return True, f"started pid={proc.pid} ready on {host}:{port}"

    # Still booting or crashed — surface last log lines.
    tail = ""
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
        tail = "\n".join(text.strip().splitlines()[-8:])
    except OSError:
        pass
    detail = f"started pid={proc.pid} but {host}:{port} not ready in {wait_s:.0f}s"
    if tail:
        detail = f"{detail}\n--- lavalink.log tail ---\n{tail}"
    return False, detail


def stop_managed_lavalink_if_owned() -> None:
    """Best-effort stop of a process we started (optional; not used on soft restart)."""
    global _OWNED_PROC, _OWNED_PID_FILE
    with _LOCK:
        proc = _OWNED_PROC
        pid_path = _OWNED_PID_FILE
        _OWNED_PROC = None
        _OWNED_PID_FILE = None
    if proc is None and pid_path is not None:
        pid = _read_pid(pid_path)
        if pid and _pid_alive(pid):
            try:
                os.kill(pid, 15)
            except OSError:
                pass
        return
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=8)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
