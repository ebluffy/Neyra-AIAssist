"""Dashboard/plugin ops helpers: zip install, file jail, log tails."""

from __future__ import annotations

import io
import logging
import re
import shutil
import threading
import uuid
import zipfile
import zlib
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("neyra.plugins.ops")

_PLUGIN_FS_LOCKS: dict[str, threading.Lock] = {}
_PLUGIN_FS_LOCKS_GUARD = threading.Lock()


def _plugin_fs_lock(pid: str) -> threading.Lock:
    with _PLUGIN_FS_LOCKS_GUARD:
        lock = _PLUGIN_FS_LOCKS.get(pid)
        if lock is None:
            lock = threading.Lock()
            _PLUGIN_FS_LOCKS[pid] = lock
        return lock

_PROTECTED_PLUGIN_IDS = frozenset({"discord"})
_ALLOWED_CONFIG_SUFFIXES = frozenset({".yaml", ".yml", ".json", ".toml", ".ini", ".conf", ".properties"})
_SAFE_ID_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,59}$")
_SECRET_NAME_RE = re.compile(
    r"(^|[/\\])(\.env($|\.)|.*credentials.*|.*secrets?.*|.*token.*|.*\.pem$|.*\.key$)",
    re.IGNORECASE,
)

MAX_ZIP_BYTES = 20 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_ZIP_FILES = 2000
_PRESERVE_ON_REPLACE = frozenset({"config.yaml", "config.yml", "logs", "data"})


def protected_plugin_ids() -> frozenset[str]:
    return _PROTECTED_PLUGIN_IDS


def normalize_plugin_id(plugin_id: str) -> str:
    return (plugin_id or "").strip().lower()


def is_safe_plugin_id(plugin_id: str) -> bool:
    return bool(_SAFE_ID_RE.match(normalize_plugin_id(plugin_id)))


def resolve_under(base: Path, rel: str) -> Path:
    """Resolve rel under base; raise ValueError on traversal."""
    base_r = base.resolve()
    candidate = (base_r / rel).resolve()
    if candidate != base_r and base_r not in candidate.parents:
        raise ValueError("path escapes plugin directory")
    return candidate


def _is_allowed_config_path(rel: str) -> bool:
    name = Path(rel).name
    if name in ("plugin.yaml", "plugin.yml"):
        return True
    if _SECRET_NAME_RE.search(rel.replace("\\", "/")):
        return False
    return Path(rel).suffix.lower() in _ALLOWED_CONFIG_SUFFIXES


def list_plugin_config_files(plugin_dir: Path) -> list[dict[str, Any]]:
    plugin_dir = plugin_dir.resolve()
    out: list[dict[str, Any]] = []
    if not plugin_dir.is_dir():
        return out
    for path in sorted(plugin_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(plugin_dir).as_posix()
        if not _is_allowed_config_path(rel):
            continue
        parts = {p.lower() for p in path.relative_to(plugin_dir).parts}
        if parts & {"node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build"}:
            continue
        out.append({"path": rel, "bytes": path.stat().st_size})
    return out


def read_plugin_file(plugin_dir: Path, rel: str, *, max_bytes: int = 512_000) -> str:
    if not _is_allowed_config_path(rel):
        raise ValueError("only config-like text files can be read")
    path = resolve_under(plugin_dir, rel)
    if not path.is_file():
        raise FileNotFoundError(rel)
    data = path.read_bytes()
    if len(data) > max_bytes:
        raise ValueError(f"file too large (>{max_bytes} bytes)")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError("file is not valid UTF-8 text") from e


def write_plugin_file(plugin_dir: Path, rel: str, content: str, *, max_bytes: int = 512_000) -> None:
    if not _is_allowed_config_path(rel):
        raise ValueError("only config-like text files can be written")
    path = resolve_under(plugin_dir, rel)
    raw = content.encode("utf-8")
    if len(raw) > max_bytes:
        raise ValueError(f"content too large (>{max_bytes} bytes)")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _find_plugin_yaml_in_zip(zf: zipfile.ZipFile) -> tuple[str, dict[str, Any]]:
    """Return (prefix_dir, manifest_dict). prefix_dir may be '' or 'foo/'."""
    names = [n for n in zf.namelist() if not n.endswith("/")]
    candidates = [n for n in names if n.replace("\\", "/").endswith("plugin.yaml")]
    if not candidates:
        raise ValueError("zip must contain plugin.yaml")
    candidates.sort(key=lambda n: (n.count("/"), len(n)))
    chosen = candidates[0].replace("\\", "/")
    raw = yaml.safe_load(zf.read(chosen)) or {}
    if not isinstance(raw, dict):
        raise ValueError("plugin.yaml must be a mapping")
    prefix = chosen.rsplit("/", 1)[0] + "/" if "/" in chosen else ""
    return prefix, raw


def _assert_zip_safe(zf: zipfile.ZipFile) -> None:
    total_uncompressed = 0
    file_count = 0
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or ".." in name.split("/"):
            raise ValueError(f"unsafe zip path: {info.filename}")
        if info.is_dir():
            continue
        file_count += 1
        if file_count > MAX_ZIP_FILES:
            raise ValueError(f"zip has too many files (max {MAX_ZIP_FILES})")
        total_uncompressed += max(0, int(info.file_size))
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
            raise ValueError(f"zip uncompressed size too large (max {MAX_UNCOMPRESSED_BYTES} bytes)")


def _copy_preserved(src_root: Path, dest_root: Path) -> None:
    """Copy config.yaml / logs / data from live module into staging (overwrite)."""
    for name in _PRESERVE_ON_REPLACE:
        src = src_root / name
        if not src.exists():
            continue
        dest = dest_root / name
        if dest.exists():
            if dest.is_dir():
                shutil.rmtree(dest)
            else:
                dest.unlink()
        if src.is_dir():
            shutil.copytree(src, dest)
        else:
            shutil.copy2(src, dest)


def _write_disabled_plugin_yaml(dest: Path, pid: str, raw_bytes: bytes) -> None:
    data = yaml.safe_load(raw_bytes.decode("utf-8")) or {}
    if not isinstance(data, dict):
        data = {}
    data["id"] = pid
    data["enabled"] = False
    dest.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _cleanup_stale_staging(modules_dir: Path, pid: str) -> None:
    for leftover in modules_dir.glob(f".{pid}.staging-*"):
        if leftover.is_dir():
            shutil.rmtree(leftover, ignore_errors=True)


def _cleanup_stale_old(modules_dir: Path, pid: str) -> None:
    """Drop previous replace backups so at most one .{pid}.old-* remains after success."""
    for leftover in modules_dir.glob(f".{pid}.old-*"):
        if leftover.is_dir():
            shutil.rmtree(leftover, ignore_errors=True)


def install_plugin_from_zip(
    modules_dir: Path,
    zip_bytes: bytes,
    *,
    replace: bool = False,
) -> dict[str, Any]:
    """Install from zip via staging dir so a failed unpack never wipes a live module."""
    if len(zip_bytes) > MAX_ZIP_BYTES:
        raise ValueError(f"zip too large (max {MAX_ZIP_BYTES} bytes)")
    modules_dir = modules_dir.resolve()
    modules_dir.mkdir(parents=True, exist_ok=True)
    try:
        zf_probe = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise ValueError("invalid zip archive") from e
    with zf_probe:
        _assert_zip_safe(zf_probe)
        prefix, manifest = _find_plugin_yaml_in_zip(zf_probe)
        pid = normalize_plugin_id(str(manifest.get("id") or "").strip())
        if not pid and prefix:
            pid = normalize_plugin_id(prefix.strip("/").split("/")[-1])
    if not is_safe_plugin_id(pid):
        raise ValueError("invalid or missing plugin id in plugin.yaml")
    if pid in _PROTECTED_PLUGIN_IDS:
        raise ValueError(f"plugin '{pid}' is protected and cannot be uploaded")

    with _plugin_fs_lock(pid):
        return _install_plugin_from_zip_locked(
            modules_dir,
            zip_bytes,
            pid=pid,
            replace=replace,
        )


def _install_plugin_from_zip_locked(
    modules_dir: Path,
    zip_bytes: bytes,
    *,
    pid: str,
    replace: bool,
) -> dict[str, Any]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise ValueError("invalid zip archive") from e

    staging: Path | None = None
    old_dir: Path | None = None
    target: Path | None = None
    try:
        with zf:
            _assert_zip_safe(zf)
            prefix, _manifest = _find_plugin_yaml_in_zip(zf)
            target = (modules_dir / pid).resolve()
            if modules_dir not in target.parents and target != modules_dir / pid:
                raise ValueError("invalid target path")
            if target.exists() and not replace:
                raise FileExistsError(pid)

            _cleanup_stale_staging(modules_dir, pid)
            _cleanup_stale_old(modules_dir, pid)
            token = uuid.uuid4().hex[:10]
            staging = modules_dir / f".{pid}.staging-{token}"
            if staging.exists():
                shutil.rmtree(staging)
            staging.mkdir(parents=True, exist_ok=True)
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                if info.is_dir():
                    continue
                if prefix and not name.startswith(prefix):
                    continue
                rel = name[len(prefix) :] if prefix else name
                if not rel or ".." in rel.split("/"):
                    continue
                dest = resolve_under(staging, rel)
                dest.parent.mkdir(parents=True, exist_ok=True)
                try:
                    data = zf.read(info.filename)
                except (zipfile.BadZipFile, zlib.error) as e:
                    raise ValueError("corrupt zip member") from e
                if len(data) > MAX_UNCOMPRESSED_BYTES:
                    raise ValueError("zip member too large after inflate")
                # Only the module-root manifest — nested plugin.yaml stays as in the zip.
                if rel in ("plugin.yaml", "plugin.yml"):
                    _write_disabled_plugin_yaml(dest, pid, data)
                else:
                    dest.write_bytes(data)

            # Copy live config/logs/data into staging before any rename (AR-20).
            if target.exists():
                _copy_preserved(target, staging)

        replaced = False
        if target.exists():
            replaced = True
            old_dir = modules_dir / f".{pid}.old-{uuid.uuid4().hex[:10]}"
            if old_dir.exists():
                shutil.rmtree(old_dir)
            target.rename(old_dir)
        staging.rename(target)
        staging = None
        # Keep .{pid}.old-* as last backup (AR-24); cleaned on next upload under lock.
        old_dir = None
        return {"plugin_id": pid, "path": str(target), "replaced": replaced}
    except Exception:
        if staging is not None and staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        if old_dir is not None and old_dir.exists():
            if target is not None and not target.exists():
                old_dir.rename(target)
            else:
                logger.warning(
                    "plugin install failed after swap; backup left at %s",
                    old_dir,
                )
        raise


def delete_plugin_dir(modules_dir: Path, plugin_id: str) -> None:
    pid = normalize_plugin_id(plugin_id)
    if not is_safe_plugin_id(pid):
        raise ValueError("invalid plugin id")
    if pid in _PROTECTED_PLUGIN_IDS:
        raise ValueError(f"plugin '{pid}' is protected and cannot be deleted")
    with _plugin_fs_lock(pid):
        target = (modules_dir.resolve() / pid).resolve()
        if modules_dir.resolve() not in target.parents:
            raise ValueError("invalid plugin path")
        if not target.is_dir():
            raise FileNotFoundError(pid)
        shutil.rmtree(target)
        _cleanup_stale_staging(modules_dir.resolve(), pid)
        _cleanup_stale_old(modules_dir.resolve(), pid)


def tail_text_file(path: Path, *, max_lines: int = 200, max_bytes: int = 512_000) -> str:
    if not path.is_file():
        return ""
    size = path.stat().st_size
    with path.open("rb") as f:
        if size > max_bytes:
            f.seek(-max_bytes, io.SEEK_END)
            f.readline()
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if len(lines) > max_lines:
        lines = lines[-max_lines:]
    return "\n".join(lines)


def list_plugin_log_sources(root: Path, plugin_id: str) -> list[dict[str, Any]]:
    """Discover tail-able log sources for a plugin (module.log, sidecars like lavalink)."""
    pid = normalize_plugin_id(plugin_id)
    if not is_safe_plugin_id(pid):
        return []
    plugin_dir = (root / "modules" / pid).resolve()
    out: list[dict[str, Any]] = []
    module_log = plugin_dir / "logs" / "module.log"
    out.append(
        {
            "id": f"plugin:{pid}",
            "label": "Модуль",
            "path": str(module_log.relative_to(root)) if module_log.is_relative_to(root) else str(module_log),
            "exists": module_log.is_file(),
        }
    )
    lava = plugin_dir / "lavalink" / "lavalink.log"
    if lava.is_file() or pid == "discord":
        out.append(
            {
                "id": "lavalink" if pid == "discord" else f"plugin:{pid}:lavalink",
                "label": "Lavalink",
                "path": str(lava.relative_to(root)) if lava.is_relative_to(root) else str(lava),
                "exists": lava.is_file(),
            }
        )
    logs_dir = plugin_dir / "logs"
    if logs_dir.is_dir():
        for path in sorted(logs_dir.glob("*.log")):
            if path.name.lower() == "module.log":
                continue
            rel = path.relative_to(plugin_dir).as_posix()
            out.append(
                {
                    "id": f"plugin:{pid}:{rel}",
                    "label": path.stem,
                    "path": str(path.relative_to(root)) if path.is_relative_to(root) else str(path),
                    "exists": True,
                }
            )
    return out


def resolve_log_source(root: Path, source: str) -> Path | None:
    """Map log source name to a file path under the server root."""
    src = (source or "system").strip().lower()
    logs = root / "logs"
    if src in ("system", "system.log"):
        return logs / "system.log"
    if src in ("audit", "api_audit", "api_audit.jsonl"):
        return logs / "api_audit.jsonl"
    if src in ("chat", "chat.log"):
        return logs / "chat.log"
    if src in ("health", "health_status.jsonl"):
        return logs / "health_status.jsonl"
    if src in ("lavalink", "discord.lavalink", "plugin:discord:lavalink"):
        return root / "modules" / "discord" / "lavalink" / "lavalink.log"
    if src.startswith("plugin:"):
        parts = src.split(":")
        pid = normalize_plugin_id(parts[1] if len(parts) > 1 else "")
        if not is_safe_plugin_id(pid):
            return None
        plugin_dir = root / "modules" / pid
        if len(parts) >= 3:
            # plugin:<id>:lavalink or plugin:<id>:relative/path.log
            rest = ":".join(parts[2:])
            if rest == "lavalink":
                return plugin_dir / "lavalink" / "lavalink.log"
            try:
                return resolve_under(plugin_dir, rest)
            except ValueError:
                return None
        cand = plugin_dir / "logs" / "module.log"
        if cand.is_file():
            return cand
        lava = plugin_dir / "lavalink" / "lavalink.log"
        if lava.is_file():
            return lava
        return logs / "system.log"
    return None
