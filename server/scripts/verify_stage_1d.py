#!/usr/bin/env python3
"""Stage 1d: AIHope dual-backend under llm.* roles (offline)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def _cfg_dual() -> dict:
    return {
        "llm": {
            "providers": {
                "aihope": {
                    "base_url": "https://aihope.fun/v1",
                    "api_key": "test-aihope-key",
                },
                "openrouter": {
                    "base_url": "https://openrouter.ai/api/v1",
                    "api_key": "test-or-key",
                },
            },
            "talk_model": {
                "provider": "openrouter",
                "model": "qwen/qwen3.8-27b:free",
                "temperature": 0.8,
                "reply_max_tokens": 220,
            },
            "brain_model": {
                "provider": "aihope",
                "model": "gpt-6-luna",
                "model_deep": "gpt-6-luna",
            },
            "memory_model": {"provider": "aihope", "model": "gpt-6-luna"},
            "vision_model": {
                "provider": "aihope",
                "model": "gpt-6-luna",
                "enabled": True,
                "use_brain_model_for_vision": True,
            },
        },
        "paths": {"data_dir": "./data"},
        "assistant": {"name": "Neyra"},
        "memory": {},
        "logging": {"level": "INFO", "system_log": "./logs/system.log"},
    }


def check_role_providers() -> list[str]:
    from core.llm.profile import (
        merge_llm_tuning_options,
        resolve_openai_compatible_connection,
        resolve_role_provider,
        resolved_brain_model,
        resolved_talk_model,
    )

    errs: list[str] = []
    cfg = _cfg_dual()
    if resolve_role_provider(cfg, "talk_model") != "openrouter":
        errs.append("talk provider expected openrouter")
    if resolve_role_provider(cfg, "brain_model") != "aihope":
        errs.append("brain provider expected aihope")

    talk = resolve_openai_compatible_connection(cfg, role="talk_model")
    brain = resolve_openai_compatible_connection(cfg, role="brain_model")
    if talk.provider != "openrouter" or "openrouter.ai" not in talk.base_url:
        errs.append(f"talk conn bad: {talk.provider} {talk.base_url}")
    if talk.api_key != "test-or-key":
        errs.append(f"talk key expected test-or-key, got {talk.api_key!r}")
    if brain.provider != "aihope" or "aihope.fun" not in brain.base_url:
        errs.append(f"brain conn bad: {brain.provider} {brain.base_url}")
    if brain.api_key != "test-aihope-key":
        errs.append(f"brain key expected test-aihope-key, got {brain.api_key!r}")

    if resolved_talk_model(cfg, talk.provider) != "qwen/qwen3.8-27b:free":
        errs.append("talk model id mismatch")
    if resolved_brain_model(cfg, brain.provider) != "gpt-6-luna":
        errs.append("brain model id mismatch")

    tuning = merge_llm_tuning_options(cfg)
    if "providers" in tuning:
        errs.append("providers must not leak into tuning options")
    if tuning.get("reply_max_tokens") != 220:
        errs.append(f"reply_max_tokens from talk_model expected 220, got {tuning.get('reply_max_tokens')}")
    if "context_window" in tuning or "max_tokens" in tuning:
        errs.append("obsolete context_window/max_tokens must not appear in tuning")
    return errs


def check_aihope_constants() -> list[str]:
    from core.llm.aihope import (
        AIHOPE_API_BASE,
        AIHOPE_BALANCE_URL,
        AIHOPE_CHAT_PATH,
        AIHOPE_IMAGES_PATH,
        AIHOPE_MESSAGES_PATH,
        AIHOPE_MODELS_PATH,
        AIHOPE_RESPONSES_PATH,
    )

    errs: list[str] = []
    if AIHOPE_API_BASE != "https://aihope.fun/v1":
        errs.append(f"base {AIHOPE_API_BASE}")
    if AIHOPE_BALANCE_URL != "https://aihope.fun/api/usage/token/":
        errs.append(f"balance {AIHOPE_BALANCE_URL}")
    expect = {
        AIHOPE_MODELS_PATH: "/models",
        AIHOPE_CHAT_PATH: "/chat/completions",
        AIHOPE_RESPONSES_PATH: "/responses",
        AIHOPE_MESSAGES_PATH: "/messages",
        AIHOPE_IMAGES_PATH: "/images/generations",
    }
    for got, want in expect.items():
        if got != want:
            errs.append(f"path {got} != {want}")
    return errs


def check_env_injection() -> list[str]:
    from core.runtime.secrets import apply_env_secrets

    errs: list[str] = []
    prev_or = os.environ.get("OPENROUTER_API_KEY")
    prev_ah = os.environ.get("AIHOPE_API_KEY")
    prev_llm = os.environ.get("LLM_API_KEY")
    os.environ["OPENROUTER_API_KEY"] = "env-or"
    os.environ["AIHOPE_API_KEY"] = "env-ah"
    os.environ["LLM_API_KEY"] = "env-generic-dead"
    try:
        cfg: dict = {"llm": {}}
        apply_env_secrets(cfg)
        llm = cfg.get("llm") if isinstance(cfg.get("llm"), dict) else {}
        or_key = (((llm.get("providers") or {}).get("openrouter") or {}).get("api_key"))
        ah = (((llm.get("providers") or {}).get("aihope") or {}).get("api_key"))
        if or_key != "env-or":
            errs.append(f"OPENROUTER not injected into llm.providers.openrouter, got {or_key!r}")
        if ah != "env-ah":
            errs.append(f"AIHOPE not injected into llm.providers.aihope, got {ah!r}")
        if llm.get("api_key"):
            errs.append(
                f"LLM_API_KEY must not inject dead llm.api_key, got {llm.get('api_key')!r}"
            )
    finally:
        if prev_or is None:
            os.environ.pop("OPENROUTER_API_KEY", None)
        else:
            os.environ["OPENROUTER_API_KEY"] = prev_or
        if prev_ah is None:
            os.environ.pop("AIHOPE_API_KEY", None)
        else:
            os.environ["AIHOPE_API_KEY"] = prev_ah
        if prev_llm is None:
            os.environ.pop("LLM_API_KEY", None)
        else:
            os.environ["LLM_API_KEY"] = prev_llm
    return errs


def check_no_backend_required() -> list[str]:
    from core.llm.profile import resolve_role_provider
    from core.runtime.config_loader import validate_config_schema

    errs: list[str] = []
    cfg = _cfg_dual()
    if "BACKEND" in cfg:
        errs.append("test cfg must not set BACKEND")
    if resolve_role_provider(cfg, None) not in {"openrouter", "aihope"}:
        errs.append("default provider inference failed")
    schema = validate_config_schema(cfg)
    if schema:
        errs.extend(f"schema: {e}" for e in schema)
    return errs


def main() -> int:
    checks = [
        ("role providers / dual conn", check_role_providers),
        ("aihope endpoint constants", check_aihope_constants),
        ("env secret injection", check_env_injection),
        ("no BACKEND required", check_no_backend_required),
    ]
    failed = 0
    for name, fn in checks:
        try:
            errs = fn()
        except Exception as e:
            print(f"FAIL {name}: {e}")
            failed += 1
            continue
        if errs:
            print(f"FAIL {name}:")
            for e in errs:
                print(f"  - {e}")
            failed += 1
        else:
            print(f"OK {name}")
    if failed:
        print(f"\n{failed} check group(s) failed")
        return 1
    print("\nAll Stage 1d checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
