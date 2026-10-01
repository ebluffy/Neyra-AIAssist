"""Layered config load + schema validation (Stage 1c).

Order: config/*.yaml → root config.yaml (short + legacy deep with warning) →
merge_plugin_configs → apply_env_secrets → apply_resolved_memory_paths → schema.
Consumers still receive one merged dict.
"""

from __future__ import annotations

import logging
import warnings
from pathlib import Path
from typing import Any

import yaml

from core.plugins.config import merge_plugin_configs
from core.runtime.paths import apply_resolved_memory_paths
from core.runtime.secrets import apply_env_secrets

logger = logging.getLogger("neyra.config_loader")

LAYER_FILES: tuple[str, ...] = (
    "llm.yaml",
    "agent.yaml",
    "memory.yaml",
    "voice.yaml",
    "modules.yaml",
    "runtime.yaml",
    "server.yaml",
)

# Top-level keys that belong in layer files, not the short root.
LEGACY_ROOT_DEEP_KEYS: frozenset[str] = frozenset(
    {
        "BACKEND",
        "openrouter",
        "llm",
        "agent",
        "memory",
        "backup",
        "external_storage",
        "voice",
        "mcp_client",
        "logging",
        "health_monitor",
        "api",
        "dashboard",
    }
)

_LEGACY_KEY_TO_LAYER: dict[str, str] = {
    "BACKEND": "llm.yaml",
    "openrouter": "llm.yaml",
    "llm": "llm.yaml",
    "agent": "agent.yaml",
    "memory": "memory.yaml",
    "backup": "memory.yaml",
    "external_storage": "memory.yaml",
    "voice": "voice.yaml",
    "mcp_client": "modules.yaml",
    "logging": "runtime.yaml",
    "health_monitor": "runtime.yaml",
    "api": "server.yaml",
    "dashboard": "server.yaml",
}


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _load_yaml_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:
        raise ValueError(f"Failed to parse YAML {path}: {e}") from e
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError(f"Config root must be a mapping: {path}")
    return raw


def _deep_merge_dicts(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Recursive dict merge: nested mappings merge; other values overwrite."""
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge_dicts(out[key], value)
        else:
            out[key] = value
    return out


def _merge_section(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Merge overlay onto base (nested dicts merge recursively; later wins on leaf keys)."""
    return _deep_merge_dicts(base, overlay)


def load_layered_yaml(server_root: Path) -> dict[str, Any]:
    """Load layer files + root config.yaml (no plugins/secrets/paths yet)."""
    cfg: dict[str, Any] = {}
    config_dir = server_root / "config"
    for name in LAYER_FILES:
        layer_path = config_dir / name
        if not layer_path.is_file():
            continue
        layer = _load_yaml_file(layer_path)
        if layer:
            cfg = _merge_section(cfg, layer)

    root_path = server_root / "config.yaml"
    root = _load_yaml_file(root_path)
    if not root and not cfg:
        return {}

    legacy_keys = sorted(k for k in root if k in LEGACY_ROOT_DEEP_KEYS)
    for key in legacy_keys:
        target = _LEGACY_KEY_TO_LAYER.get(key, "config/*.yaml")
        msg = (
            f"legacy root deep key '{key}' — move to server/config/{target}"
        )
        logger.warning(msg)
        warnings.warn(msg, UserWarning, stacklevel=2)

    if root:
        cfg = _merge_section(cfg, root)
    return cfg


def validate_config_schema(cfg: dict[str, Any]) -> list[str]:
    """Return human-readable schema errors (empty list = ok)."""
    errors: list[str] = []
    if not isinstance(cfg, dict):
        return ["config: expected mapping, got %s" % type(cfg).__name__]

    # Removed config shapes (no dual-read / aliases).
    if "BACKEND" in cfg:
        errors.append("BACKEND: removed — set llm.<role>.provider")
    if "openrouter" in cfg:
        errors.append("openrouter: removed — use llm.talk_model / llm.brain_model / …")
    if "vision" in cfg:
        errors.append("vision: removed — use llm.vision_model")
    if "internal_api" in cfg:
        errors.append("internal_api: removed — use api: (core API in config/server.yaml)")

    dash = cfg.get("dashboard")
    if isinstance(dash, dict) and "public_base_url" in dash:
        errors.append(
            "dashboard.public_base_url: removed — use api.public_base_url "
            "(one public origin for UI + API)"
        )
    def _req_dict(key: str) -> dict[str, Any] | None:
        val = cfg.get(key)
        if val is None:
            errors.append(f"{key}: missing (expected dict)")
            return None
        if not isinstance(val, dict):
            errors.append(f"{key}: expected dict, got {type(val).__name__}")
            return None
        return val

    def _opt_dict(key: str) -> dict[str, Any] | None:
        if key not in cfg:
            return None
        val = cfg.get(key)
        if not isinstance(val, dict):
            errors.append(f"{key}: expected dict, got {type(val).__name__}")
            return None
        return val

    paths = _req_dict("paths")
    if paths is not None:
        dd = paths.get("data_dir")
        if dd is None or (isinstance(dd, str) and not dd.strip()):
            errors.append("paths.data_dir: expected non-empty str")
        elif not isinstance(dd, str):
            errors.append(f"paths.data_dir: expected str, got {type(dd).__name__}")

    logging_cfg = _req_dict("logging")
    if logging_cfg is not None:
        level = logging_cfg.get("level")
        if level is None or (isinstance(level, str) and not str(level).strip()):
            errors.append("logging.level: expected non-empty str")
        elif not isinstance(level, str):
            errors.append(f"logging.level: expected str, got {type(level).__name__}")
        slog = logging_cfg.get("system_log")
        if slog is None or (isinstance(slog, str) and not str(slog).strip()):
            errors.append("logging.system_log: expected non-empty str")
        elif not isinstance(slog, str):
            errors.append(f"logging.system_log: expected str, got {type(slog).__name__}")

    _req_dict("assistant")
    _req_dict("memory")

    llm_cfg = _req_dict("llm")
    if llm_cfg is not None:
        talk = llm_cfg.get("talk_model")
        if not isinstance(talk, dict):
            errors.append("llm.talk_model: missing (expected dict with model + provider)")
        else:
            if not str(talk.get("model") or "").strip():
                errors.append("llm.talk_model.model: expected non-empty str")
            if not str(talk.get("provider") or "").strip():
                errors.append("llm.talk_model.provider: expected non-empty str")

    _opt_dict("agent")
    _opt_dict("voice")
    _opt_dict("backup")
    _opt_dict("external_storage")
    _opt_dict("mcp_client")
    _opt_dict("health_monitor")
    _opt_dict("api")
    _opt_dict("dashboard")
    _opt_dict("llm")
    _opt_dict("plugins")
    _opt_dict("system")

    return errors


def load_layered_config(server_root: Path, *, validate: bool = True) -> dict[str, Any]:
    """Full load pipeline used by main / healthcheck / invoke_plugin."""
    root = Path(server_root)
    cfg = load_layered_yaml(root)
    if not cfg and not (root / "config.yaml").is_file():
        raise FileNotFoundError(f"Config not found: {root / 'config.yaml'}")
    merge_plugin_configs(cfg, root)
    apply_env_secrets(cfg)
    apply_resolved_memory_paths(cfg, root)
    if validate:
        errs = validate_config_schema(cfg)
        if errs:
            raise ValueError("config schema validation failed:\n  - " + "\n  - ".join(errs))
    return cfg


# Top-level key → layer file under server/config/ (dashboard runtime allowlist).
_RUNTIME_PERSIST_LAYER: dict[str, str] = {
    "llm": "llm.yaml",
    "agent": "agent.yaml",
    "memory": "memory.yaml",
    "logging": "runtime.yaml",
    "health_monitor": "runtime.yaml",
}


def _set_dotted(cfg: dict[str, Any], path: str, value: Any) -> None:
    keys = [p for p in path.split(".") if p]
    if not keys:
        raise ValueError("empty config path")
    cur: dict[str, Any] = cfg
    for k in keys[:-1]:
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[keys[-1]] = value


def persist_allowlisted_updates(server_root: Path, updates: dict[str, Any]) -> list[str]:
    """Write dotted allowlisted keys into layer YAML files. Returns relative paths touched.

    Does not touch root ``config.yaml`` or secrets. Layer comments may be rewritten by PyYAML.
    """
    if not updates:
        return []
    root = Path(server_root)
    config_dir = root / "config"
    config_dir.mkdir(parents=True, exist_ok=True)

    by_layer: dict[str, dict[str, Any]] = {}
    for path, value in updates.items():
        top = str(path).split(".", 1)[0].strip()
        layer_name = _RUNTIME_PERSIST_LAYER.get(top)
        if not layer_name:
            raise ValueError(f"no layer mapping for config path: {path}")
        by_layer.setdefault(layer_name, {})[str(path)] = value

    touched: list[str] = []
    prepared: list[tuple[Path, Path, str, int]] = []  # final, tmp, rel, key_count
    for layer_name, paths in by_layer.items():
        layer_path = config_dir / layer_name
        current = _load_yaml_file(layer_path) if layer_path.is_file() else {}
        for dotted, val in paths.items():
            _set_dotted(current, dotted, val)
        text = yaml.safe_dump(
            current,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
        tmp = layer_path.with_suffix(layer_path.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        prepared.append((layer_path, tmp, f"config/{layer_name}", len(paths)))

    # Commit all layers only after every tmp is written; on rename failure restore previous files.
    backups: list[tuple[Path, Path | None]] = []  # (final_path, bak_or_None if newly created)
    try:
        for layer_path, tmp, rel, nkeys in prepared:
            bak: Path | None = None
            if layer_path.is_file():
                bak = layer_path.with_suffix(layer_path.suffix + ".bak")
                # Replace existing → bak (atomic on same filesystem).
                layer_path.replace(bak)
            backups.append((layer_path, bak))
            tmp.replace(layer_path)
            touched.append(rel)
            logger.info("Persisted runtime config updates to %s (%s keys)", layer_path, nkeys)
    except Exception:
        for layer_path, bak in reversed(backups):
            try:
                if bak is not None and bak.is_file():
                    bak.replace(layer_path)
                elif layer_path.is_file() and bak is None:
                    layer_path.unlink()
            except OSError:
                logger.exception("Failed to restore %s after persist error", layer_path)
        for _layer_path, tmp, _rel, _n in prepared:
            try:
                if tmp.is_file():
                    tmp.unlink()
            except OSError:
                pass
        for _layer_path, bak in backups:
            if bak is None:
                continue
            try:
                if bak.is_file():
                    bak.unlink()
            except OSError:
                pass
        raise
    else:
        for _layer_path, bak in backups:
            if bak is None:
                continue
            try:
                if bak.is_file():
                    bak.unlink()
            except OSError:
                pass
    return touched
