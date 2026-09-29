"""
Runtime helpers: HTTP server, health, secrets, event bus, identity, time, storage.

Canonical: ``from core.runtime.server import …``, ``from core.runtime.event_bus import …``, …
Heavy modules (server / health) are exported lazily.
"""

from __future__ import annotations

from typing import Any

from core.runtime.secrets import apply_env_secrets, load_dotenv_file
from core.runtime.win_runtime import apply_runtime_patches

__all__ = [
    "HealthMonitor",
    "apply_env_secrets",
    "apply_runtime_patches",
    "attach_resident_plugins",
    "load_dotenv_file",
    "project_root",
    "run_neyra_server",
]

_SERVER_NAMES = frozenset({"attach_resident_plugins", "project_root", "run_neyra_server"})
_HEALTH_NAMES = frozenset({"HealthMonitor"})


def __getattr__(name: str) -> Any:
    if name in _SERVER_NAMES:
        from core.runtime import server as mod

        return getattr(mod, name)
    if name in _HEALTH_NAMES:
        from core.runtime import health as mod

        return getattr(mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
