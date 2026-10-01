"""Neyra HTTP/WebSocket API (core control plane).

Keep this package init free of FastAPI imports so lightweight modules
(e.g. ``dashboard_auth``) can be used in offline CI jobs without installing
the full API stack.
"""

from __future__ import annotations

import importlib
from typing import Any

__all__ = [
    "API_VERSION",
    "ApiError",
    "api_public_root",
    "api_public_v1",
    "assert_api_bind_safe",
    "build_app",
    "site_public_origin",
]


def __getattr__(name: str) -> Any:
    if name == "app":
        return importlib.import_module("core.api.app")
    if name in __all__:
        app_mod = importlib.import_module("core.api.app")
        return getattr(app_mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
