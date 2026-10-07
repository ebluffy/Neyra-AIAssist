"""Dashboard/plugin ops helpers: zip install, file jail, log tails."""

from __future__ import annotations

import io
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

import yaml

_PROTECTED_PLUGIN_IDS = frozenset({"discord"})
_ALLOWED_CONFIG_SUFFIXES = frozenset({".yaml", ".yml", ".json", ".toml", ".ini", ".conf", ".properties"})
_SAFE_ID_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,59}$")


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


def list_plugin_config_files(plugin_dir: Path) -> list[dict[str, Any]]:
    plugin_dir = plugin_dir.resolve()
    out: list[dict[str, Any]] = []
    if not plugin_dir.is_dir():
        return out
    for path in sorted(plugin_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in _ALLOWED_CONFIG_SUFFIXES:
            continue
        # Skip heavy/vendor trees
        parts = {p.lower() for p in path.relative_to(plugin_dir).parts}
        if parts & {"node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "build"}:
            continue
        rel = path.relative_to(plugin_dir).as_posix()
        out.append({"path": rel, "bytes": path.stat().st_size})
    return out


def read_plugin_file(plugin_dir: Path, rel: str, *, max_bytes: int = 512_000) -> str:
    path = resolve_under(plugin_dir, rel)
    if not path.is_file():
        raise FileNotFoundError(rel)
    data = path.read_bytes()
    if len(data) > max_bytes:
        raise ValueError(f"file too large (>{max_bytes} bytes)")
    return data.decode("utf-8")


def write_plugin_file(plugin_dir: Path, rel: str, content: str, *, max_bytes: int = 512_000) -> None:
    path = resolve_under(plugin_dir, rel)
    raw = content.encode("utf-8")
    if len(raw) > max_bytes:
        raise ValueError(f"content too large (>{max_bytes} bytes)")
    if path.suffix.lower() not in _ALLOWED_CONFIG_SUFFIXES and path.name != "plugin.yaml":
        # allow plugin.yaml even if suffix check already covers it
        if path.name not in ("plugin.yaml", "plugin.yml"):
            raise ValueError("only config-like text files can be written")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _find_plugin_yaml_in_zip(zf: zipfile.ZipFile) -> tuple[str, dict[str, Any]]:
    """Return (prefix_dir, manifest_dict). prefix_dir may be '' or 'foo/'."""
    names = [n for n in zf.namelist() if not n.endswith("/")]
    candidates = [n for n in names if n.replace("\\", "/").endswith("plugin.yaml")]
    if not candidates:
        raise ValueError("zip must contain plugin.yaml")
    # Prefer shallowest plugin.yaml
    candidates.sort(key=lambda n: (n.count("/"), len(n)))
    chosen = candidates[0].replace("\\", "/")
    raw = yaml.safe_load(zf.read(chosen)) or {}
    if not isinstance(raw, dict):
        raise ValueError("plugin.yaml must be a mapping")
    prefix = chosen.rsplit("/", 1)[0] + "/" if "/" in chosen else ""
    return prefix, raw


def install_plugin_from_zip(modules_dir: Path, zip_bytes: bytes) -> dict[str, Any]:
    modules_dir = modules_dir.resolve()
    modules_dir.mkdir(parents=True, exist_ok=True)
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise ValueError("invalid zip archive") from e
    with zf:
        # Zip-slip guard
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/"):
                raise ValueError(f"unsafe zip path: {info.filename}")
        prefix, manifest = _find_plugin_yaml_in_zip(zf)
        pid = normalize_plugin_id(str(manifest.get("id") or "").strip())
        if not pid:
            # fall back to folder name in zip
            if prefix:
                pid = normalize_plugin_id(prefix.strip("/").split("/")[-1])
        if not is_safe_plugin_id(pid):
            raise ValueError("invalid or missing plugin id in plugin.yaml")
        if pid in _PROTECTED_PLUGIN_IDS:
            raise ValueError(f"plugin '{pid}' is protected and cannot be uploaded")
        target = (modules_dir / pid).resolve()
        if modules_dir not in target.parents and target != modules_dir / pid:
            raise ValueError("invalid target path")
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir():
                continue
            if prefix and not name.startswith(prefix):
                continue
            rel = name[len(prefix) :] if prefix else name
            if not rel or ".." in rel.split("/"):
                continue
            dest = resolve_under(target, rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(info.filename))
        # Ensure id in plugin.yaml matches folder
        py = target / "plugin.yaml"
        if py.is_file():
            data = yaml.safe_load(py.read_text(encoding="utf-8")) or {}
            if isinstance(data, dict):
                data["id"] = pid
                py.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
        return {"plugin_id": pid, "path": str(target)}


def delete_plugin_dir(modules_dir: Path, plugin_id: str) -> None:
    pid = normalize_plugin_id(plugin_id)
    if not is_safe_plugin_id(pid):
        raise ValueError("invalid plugin id")
    if pid in _PROTECTED_PLUGIN_IDS:
        raise ValueError(f"plugin '{pid}' is protected and cannot be deleted")
    target = (modules_dir.resolve() / pid).resolve()
    if modules_dir.resolve() not in target.parents:
        raise ValueError("invalid plugin path")
    if not target.is_dir():
        raise FileNotFoundError(pid)
    shutil.rmtree(target)


def tail_text_file(path: Path, *, max_lines: int = 200, max_bytes: int = 512_000) -> str:
    if not path.is_file():
        return ""
    size = path.stat().st_size
    with path.open("rb") as f:
        if size > max_bytes:
            f.seek(-max_bytes, io.SEEK_END)
            f.readline()  # drop partial first line
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if len(lines) > max_lines:
        lines = lines[-max_lines:]
    return "\n".join(lines)


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
        pid = normalize_plugin_id(src.split(":", 1)[1])
        if not is_safe_plugin_id(pid):
            return None
        # Prefer module-local logs/, else fall back to system.log filtered by caller
        cand = root / "modules" / pid / "logs" / "module.log"
        if cand.is_file():
            return cand
        lava = root / "modules" / pid / "lavalink" / "lavalink.log"
        if lava.is_file():
            return lava
        return logs / "system.log"
    return None
