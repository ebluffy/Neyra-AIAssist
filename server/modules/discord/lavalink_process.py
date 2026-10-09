"""Start/stop local Lavalink.jar with the Discord module.

When ``discord.music.managed_lavalink`` is true (default) and a node URI is
loopback, Discord bootstrap ensures the JAR listens before music preflight.
Disabling the Discord plugin via Control API stops the managed JVM.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import signal
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
_DEFAULT_PASSWORD = "youshallnotpass"


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


def _node_password(node: dict[str, Any]) -> str:
    pwd = str(node.get("password") or "").strip()
    return pwd or _DEFAULT_PASSWORD


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


def _terminate_pid(pid: int, *, wait_s: float = 8.0) -> None:
    if not _pid_alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return
        time.sleep(0.2)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _ensure_application_yml(lava_dir: Path, *, password: str) -> Path:
    """Ensure application.yml exists and matches node password + loopback bind."""
    yml = lava_dir / "application.yml"
    if not yml.is_file():
        example = lava_dir / "application.example.yml"
        if not example.is_file():
            raise FileNotFoundError(f"No application.yml under {lava_dir}")
        text = example.read_text(encoding="utf-8")
        created = True
    else:
        text = yml.read_text(encoding="utf-8")
        created = False

    text2, n_pwd = re.subn(
        r'(?m)^(\s*password:\s*")[^"]*(")',
        rf'\1{password}\2',
        text,
        count=1,
    )
    text2, n_addr = re.subn(
        r'(?m)^(\s*address:\s*)\S+',
        r'\g<1>127.0.0.1',
        text2,
        count=1,
    )
    # SSRF hardening: Discord play never needs Lavalink HTTP/local sources.
    text2, n_http = re.subn(
        r"(?m)^(\s*http:\s*)(?:true|false)\s*$",
        r"\1false",
        text2,
        count=1,
    )
    text2, n_local = re.subn(
        r"(?m)^(\s*local:\s*)(?:true|false)\s*$",
        r"\1false",
        text2,
        count=1,
    )
    repaired = text2 != text
    if created or repaired:
        yml.write_text(text2, encoding="utf-8")
        if created:
            logger.info(
                "discord.lavalink: created application.yml from example "
                "(password_set=%s loopback_bind=%s http_off=%s local_off=%s)",
                n_pwd > 0,
                n_addr > 0,
                n_http > 0,
                n_local > 0,
            )
        else:
            logger.warning(
                "discord.lavalink: repaired application.yml "
                "(password_aligned=%s loopback_bind=%s http_off=%s local_off=%s)",
                n_pwd > 0 and repaired,
                n_addr > 0,
                n_http > 0,
                n_local > 0,
            )
    return yml


def _spawn_jar(java: str, jar: Path, lava_dir: Path, log_path: Path) -> subprocess.Popen:
    log_f = open(log_path, "a", encoding="utf-8", errors="replace")
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
    try:
        return subprocess.Popen(
            [java, "-jar", str(jar)],
            cwd=str(lava_dir),
            stdout=log_f,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=(os.name != "nt"),
            creationflags=creationflags,
        )
    except Exception:
        log_f.close()
        raise


def ensure_managed_lavalink(config: dict[str, Any], plugin_dir: Path) -> tuple[bool, str]:
    """Ensure local Lavalink is up when Discord music expects a loopback node."""
    global _OWNED_PROC

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
    password = _node_password(node)
    wait_s = float(music.get("managed_lavalink_ready_seconds") or 90)

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
        _ensure_application_yml(lava_dir, password=password)
    except FileNotFoundError as e:
        return False, str(e)

    pid_path = _pid_file(lava_dir)
    log_path = lava_dir / "lavalink.log"

    with _LOCK:
        if _port_open(host, port):
            return True, f"already listening on {host}:{port}"

        existing = _read_pid(pid_path)
        if existing and _pid_alive(existing):
            # Wait full budget — never spawn a second JVM while the first is alive.
            if _wait_port(host, port, wait_s):
                return True, f"existing managed pid={existing} ready on {host}:{port}"
            logger.warning(
                "discord.lavalink: pid %s alive but %s:%s never opened — terminating before restart",
                existing,
                host,
                port,
            )
            _terminate_pid(existing)
            try:
                if pid_path.is_file():
                    pid_path.unlink()
            except OSError:
                pass

        try:
            proc = _spawn_jar(java, jar, lava_dir, log_path)
        except OSError as e:
            return False, f"failed to spawn Lavalink: {e}"

        _OWNED_PROC = proc
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


def stop_managed_lavalink(plugin_dir: Path | None = None) -> str:
    """Stop managed Lavalink (in-memory handle and/or pid file). Safe if nothing running."""
    global _OWNED_PROC

    lava_dir = _lavalink_dir(plugin_dir or Path(__file__).resolve().parent)
    pid_path = _pid_file(lava_dir)
    killed: list[str] = []

    with _LOCK:
        proc = _OWNED_PROC
        _OWNED_PROC = None
        file_pid = _read_pid(pid_path)

    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=8)
            killed.append(f"proc={proc.pid}")
        except Exception:
            try:
                proc.kill()
                killed.append(f"proc_kill={proc.pid}")
            except Exception:
                pass

    if file_pid and _pid_alive(file_pid):
        _terminate_pid(file_pid)
        killed.append(f"pidfile={file_pid}")

    try:
        if pid_path.is_file():
            pid_path.unlink()
    except OSError:
        pass

    if killed:
        msg = "stopped " + ",".join(killed)
        logger.info("discord.lavalink: %s", msg)
        return msg
    return "nothing to stop"


# Back-compat alias
def stop_managed_lavalink_if_owned() -> None:
    stop_managed_lavalink()
