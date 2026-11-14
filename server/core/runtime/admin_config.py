"""Admin config snapshot and validated writes (Wave 3).

Pure helpers behind ``GET /v1/config`` and ``PUT /v1/config``: no FastAPI and no
agent here, so the rules can be unit-tested offline.

Secrets never enter the snapshot. Only a fixed list of environment variable names
is reported as ``set`` / ``missing``; values are read solely to build the redaction
list for log tails and are never returned.
"""

from __future__ import annotations

import os
import re
from typing import Any, Iterable, Mapping

LANES: tuple[str, ...] = ("talk", "brain", "memory", "vision")

# Provider ids and model ids are short ASCII tokens. Model ids may contain / : @ + ~ . -
_PROVIDER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$")

# Environment names reported as flags in the snapshot. Order is stable for the UI.
SECRET_ENV_NAMES: tuple[str, ...] = (
    "AIHOPE_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY",
    "DISCORD_TOKEN",
    "NEYRA_IDENTITY_JWT_SECRET",
    "NEYRA_SERVICE_KEY",
)

_INT_FIELDS: dict[str, tuple[int, int]] = {
    "memory.stm_max_messages": (1, 200),
    "memory.max_records": (100, 1_000_000),
    "memory.rag_top_k": (1, 20),
    "memory.diary_max_entries": (100, 100_000),
    "memory.session_archive.threshold_messages": (0, 1_000),
}

_BOOL_FIELDS: frozenset[str] = frozenset(
    {
        "memory.session_archive.enabled",
        "memory.session_archive.on_stm_threshold",
    }
)

_LANE_INT_FIELDS: dict[str, tuple[int, int]] = {
    "context_window": (1, 2_000_000),
    "max_tokens": (1, 200_000),
    "reply_max_tokens": (1, 200_000),
}

_LANE_FLOAT_FIELDS: dict[str, tuple[float, float]] = {
    "temperature": (0.0, 2.0),
}


def _lane_paths() -> set[str]:
    out: set[str] = set()
    for lane in LANES:
        for field in ("provider", "model", "thinking", "thinking_effort", *_LANE_FLOAT_FIELDS, *_LANE_INT_FIELDS):
            # talk caps the visible reply with reply_max_tokens; max_tokens is unused there.
            if lane != "talk" and field == "reply_max_tokens":
                continue
            if lane == "talk" and field == "max_tokens":
                continue
            out.add(f"llm.{lane}_model.{field}")
    return out


# Everything the admin panel may write. Anything else is rejected, not ignored.
ADMIN_CONFIG_WRITE_ALLOWLIST: frozenset[str] = frozenset(
    {*_lane_paths(), *_INT_FIELDS, *_BOOL_FIELDS}
)


class AdminConfigError(ValueError):
    """Validation failure carrying an API error code and a safe message."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _cfg_get(cfg: Mapping[str, Any], path: str) -> Any:
    cur: Any = cfg
    for part in path.split("."):
        if not isinstance(cur, Mapping) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def validate_admin_updates(
    updates: Mapping[str, Any],
    cfg: Mapping[str, Any],
    providers: Iterable[str],
) -> dict[str, Any]:
    """Return normalized updates or raise AdminConfigError.

    Unknown paths are rejected with ``unknown_field`` — the panel must not be able
    to write arbitrary config keys (secrets, paths, api tokens).
    """
    if not isinstance(updates, Mapping) or not updates:
        raise AdminConfigError("empty_update", "Нет изменений: передайте хотя бы одно поле.")
    provider_ids = {str(p).strip() for p in providers if str(p).strip()}
    clean: dict[str, Any] = {}

    for raw_path, value in updates.items():
        path = str(raw_path).strip()
        if path not in ADMIN_CONFIG_WRITE_ALLOWLIST:
            raise AdminConfigError(
                "unknown_field",
                f"Поле не разрешено для записи: {path or '(пусто)'}.",
            )

        if path in _INT_FIELDS:
            low, high = _INT_FIELDS[path]
            if type(value) is not int or not (low <= value <= high):
                raise AdminConfigError(
                    "invalid_value",
                    f"{path}: ожидается целое от {low} до {high}.",
                )
            clean[path] = value
            continue

        if path in _BOOL_FIELDS:
            if type(value) is not bool:
                raise AdminConfigError("invalid_value", f"{path}: ожидается true или false.")
            clean[path] = value
            continue

        lane_field = path.rsplit(".", 1)[-1]
        if lane_field == "provider":
            provider = str(value or "").strip()
            if not _PROVIDER_RE.match(provider):
                raise AdminConfigError("invalid_value", f"{path}: некорректный идентификатор провайдера.")
            if provider_ids and provider not in provider_ids:
                raise AdminConfigError(
                    "unknown_provider",
                    f"{path}: провайдер '{provider}' не настроен в llm.providers.",
                )
            clean[path] = provider
            continue

        if lane_field == "thinking_effort":
            from core.agent.llm_setup import THINKING_EFFORTS

            effort = str(value or "").strip().lower()
            if effort not in THINKING_EFFORTS:
                raise AdminConfigError(
                    "invalid_value",
                    f"{path}: ожидается одно из {', '.join(THINKING_EFFORTS)}.",
                )
            clean[path] = effort
            continue

        if lane_field == "thinking":
            if type(value) is not bool:
                raise AdminConfigError("invalid_value", f"{path}: ожидается true или false.")
            clean[path] = value
            continue

        if lane_field == "model":
            model = str(value or "").strip()
            if not _MODEL_RE.match(model):
                raise AdminConfigError("invalid_value", f"{path}: некорректный идентификатор модели.")
            clean[path] = model
            continue

        if lane_field in _LANE_FLOAT_FIELDS:
            low, high = _LANE_FLOAT_FIELDS[lane_field]
            number = _as_number(value)
            if number is None or not (low <= number <= high):
                raise AdminConfigError("invalid_value", f"{path}: ожидается число от {low} до {high}.")
            clean[path] = number
            continue

        if lane_field in _LANE_INT_FIELDS:
            low, high = _LANE_INT_FIELDS[lane_field]
            if type(value) is not int or not (low <= value <= high):
                raise AdminConfigError("invalid_value", f"{path}: ожидается целое от {low} до {high}.")
            clean[path] = value
            continue

        raise AdminConfigError("unknown_field", f"Поле не разрешено для записи: {path}.")

    # Cross-field sanity: a lane model cannot stay empty after the update.
    for lane in LANES:
        provider_path = f"llm.{lane}_model.provider"
        model_path = f"llm.{lane}_model.model"
        if provider_path in clean and model_path not in clean:
            existing = str(_cfg_get(cfg, model_path) or "").strip()
            if not existing:
                raise AdminConfigError(
                    "invalid_value",
                    f"{provider_path}: сначала задайте модель для лейна {lane}.",
                )
    return clean


def requires_restart_fields(paths: Iterable[str]) -> list[str]:
    """Fields that the running process cannot apply without a restart.

    LLM lanes are rebound in-process (``agent._setup_llm``), so they are hot.
    Memory limits and the auto-compaction threshold are read by stores/hub built
    at startup — writing them to disk is safe, applying them is not.
    """
    return sorted(path for path in paths if str(path).startswith("memory."))


def secret_flags(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """``set`` / ``missing`` per known secret name. Values are never returned."""
    source = os.environ if env is None else env
    return {
        name: "set" if (source.get(name) or "").strip() else "missing"
        for name in SECRET_ENV_NAMES
    }


def secret_values(env: Mapping[str, str] | None = None) -> list[str]:
    """Secret values for log redaction only. Never serialize this list."""
    source = os.environ if env is None else env
    return [
        value.strip()
        for value in (source.get(name) or "" for name in SECRET_ENV_NAMES)
        if len(value.strip()) >= 8
    ]


def _mcp_servers(cfg: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Names and enabled flags only: commands and env may contain tokens."""
    mcp = cfg.get("mcp_client")
    if not isinstance(mcp, Mapping):
        return []
    servers = mcp.get("servers")
    out: list[dict[str, Any]] = []
    if isinstance(servers, Mapping):
        servers = list(servers.values())
    if not isinstance(servers, list):
        return out
    for item in servers:
        if isinstance(item, str):
            name = item.strip()
            if name:
                out.append({"name": name, "enabled": True})
            continue
        if isinstance(item, Mapping):
            name = str(item.get("name") or item.get("id") or "").strip()
            if not name:
                continue
            enabled = item.get("enabled")
            out.append({"name": name, "enabled": True if enabled is None else bool(enabled)})
    return out


def _memory_limits(cfg: Mapping[str, Any]) -> dict[str, int]:
    defaults = {
        "memory.stm_max_messages": 10,
        "memory.max_records": 10_000,
        "memory.rag_top_k": 3,
        "memory.diary_max_entries": 5_000,
    }
    out: dict[str, int] = {}
    for path, default in defaults.items():
        value = _cfg_get(cfg, path)
        out[path] = value if type(value) is int else default
    return out


def admin_config_snapshot(
    cfg: Mapping[str, Any],
    *,
    version: str,
    uptime_seconds: int,
    policy: Mapping[str, Any],
    resolved_models: Mapping[str, str],
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Read-only config view for the admin panel. No secret values."""
    llm = cfg.get("llm") if isinstance(cfg.get("llm"), Mapping) else {}
    lanes: dict[str, Any] = {}
    for lane in LANES:
        role = llm.get(f"{lane}_model") if isinstance(llm.get(f"{lane}_model"), Mapping) else {}
        lanes[lane] = {
            "provider": str(role.get("provider") or llm.get("provider") or ""),
            "model": str(role.get("model") or ""),
            "resolved_model": str(resolved_models.get(lane) or ""),
            "temperature": role.get("temperature"),
            "context_window": role.get("context_window"),
            "max_tokens": role.get("max_tokens", role.get("reply_max_tokens")),
            "enabled": role.get("enabled"),
            "thinking": role.get("thinking"),
            "thinking_effort": role.get("thinking_effort")
            or ("default" if role.get("thinking") is True else "off" if role.get("thinking") is False else "default"),
        }

    providers = llm.get("providers") if isinstance(llm.get("providers"), Mapping) else {}
    mcp = cfg.get("mcp_client") if isinstance(cfg.get("mcp_client"), Mapping) else {}

    return {
        "version": version,
        "uptime_seconds": int(uptime_seconds),
        "lanes": lanes,
        "providers": sorted(str(name) for name in providers),
        "memory": {
            "limits": _memory_limits(cfg),
            "autocompact": {
                "enabled": bool(policy.get("compaction_enabled")),
                "mode": str(policy.get("mode") or "off"),
                "threshold_messages": int(policy.get("threshold_messages") or 0),
            },
        },
        "mcp": {
            "enabled": bool(mcp.get("enabled")),
            "servers": _mcp_servers(cfg),
        },
        "secrets": secret_flags(env),
        "editable": sorted(ADMIN_CONFIG_WRITE_ALLOWLIST),
    }
