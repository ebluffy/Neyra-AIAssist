#!/usr/bin/env python3
"""Regenerate docs/config-keys.md (one leaf key per row) from tracked examples."""

from __future__ import annotations

from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
SERVER = REPO / "server"
OUT = REPO / "docs" / "config-keys.md"

FILES = [
    ("server/config.yaml", SERVER / "config.example.yaml"),
    ("server/config/llm.yaml", SERVER / "config" / "llm.example.yaml"),
    ("server/config/agent.yaml", SERVER / "config" / "agent.example.yaml"),
    ("server/config/memory.yaml", SERVER / "config" / "memory.example.yaml"),
    ("server/config/voice.yaml", SERVER / "config" / "voice.example.yaml"),
    ("server/config/modules.yaml", SERVER / "config" / "modules.example.yaml"),
    ("server/config/runtime.yaml", SERVER / "config" / "runtime.example.yaml"),
    ("server/config/server.yaml", SERVER / "config" / "server.example.yaml"),
]

ENV = {
    "openrouter.api_key": "OPENROUTER_API_KEY",
    "llm.api_key": "LLM_API_KEY",
    "memory.hf_token": "HF_TOKEN (legacy: HUGGING_FACE_HUB_TOKEN)",
    "paths.data_dir": "NEYRA_DATA_DIR",
    "internal_api.host": "INTERNAL_API_BIND_HOST",
    "internal_api.token": "INTERNAL_API_TOKEN",
    "internal_api.viewer_token": "INTERNAL_API_VIEWER_TOKEN",
    "internal_api.maint_token": "INTERNAL_API_MAINT_TOKEN",
    "internal_api.webhook_inbound_secret": "WEBHOOK_INBOUND_SECRET",
    "voice.stt.cloud.groq.api_key": "GROQ_API_KEY",
    "voice.stt.cloud.deepgram.api_key": "DEEPGRAM_API_KEY",
    "voice.tts.cloud.api_key": "YANDEX_API_KEY",
    "voice.tts.cloud.folder_id": "YANDEX_FOLDER_ID (legacy: YANDEX_ID_KEY)",
    "discord.token": "DISCORD_TOKEN",
}

PLACEHOLDER_DEFAULTS = {
    "agent.fast_path.intents": "see agent.example.yaml",
    "assistant.system_prompt": "see config.example.yaml",
}

# Prefix → consumer / reader (longest match wins). Not invented beyond known loaders.
SOURCE_PREFIXES: tuple[tuple[str, str], ...] = (
    ("plugins.local_voice.", "merge_plugin_configs → plugins.local_voice; stub.py"),
    ("paths.", "core/runtime/paths.py"),
    ("system.", "runtime/timeutil, memory display"),
    ("assistant.", "core/agent/persona.py"),
    ("BACKEND", "main.py, core/llm/"),
    ("openrouter.", "core/llm/, core/agent/llm_setup.py"),
    ("llm.", "core/llm/, secrets.LLM_API_KEY"),
    ("agent.", "core/agent/"),
    ("memory.", "core/memory/, apply_resolved_memory_paths"),
    ("backup.", "core/runtime/backup.py"),
    ("external_storage.", "core/runtime/external_storage.py"),
    ("voice.", "core/voice/config.py"),
    ("mcp_client.", "core/runtime/mcp_client.py"),
    ("logging.", "main.py bootstrap"),
    ("health_monitor.", "core/runtime/health.py"),
    ("internal_api.", "modules/internal_api/"),
    ("dashboard.", "modules/internal_api/ (dashboard)"),
)


def source_for(key: str) -> str:
    for prefix, src in SOURCE_PREFIXES:
        if key == prefix.rstrip(".") or key.startswith(prefix):
            return src
    return "layered config consumers"


def typ(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int) and not isinstance(v, bool):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return "str"
    if isinstance(v, list):
        return "list"
    if isinstance(v, dict):
        return "dict"
    return type(v).__name__


def fmt_default(key: str, v) -> str:
    if key in PLACEHOLDER_DEFAULTS:
        return PLACEHOLDER_DEFAULTS[key]
    if isinstance(v, str):
        s = v.replace("\n", "\\n").replace("|", "\\|")
        if len(s) > 60:
            s = s[:57] + "..."
        return f'"{s}"'
    if isinstance(v, list):
        if not v:
            return "[]"
        return "see example yaml"
    if isinstance(v, dict):
        return "{}" if not v else "{...}"
    return repr(v)


def walk(obj, prefix=""):
    if isinstance(obj, dict):
        if not obj:
            yield prefix, obj
            return
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, dict):
                yield from walk(v, path)
            else:
                yield path, v
    else:
        yield prefix, obj


def main() -> None:
    rows = []
    for target, path in FILES:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            continue
        for key, val in walk(data):
            rows.append(
                (
                    key,
                    typ(val),
                    fmt_default(key, val),
                    source_for(key),
                    target,
                    ENV.get(key, "—"),
                    "current",
                )
            )

    lv_path = SERVER / "modules" / "local_voice" / "config.example.yaml"
    lv = yaml.safe_load(lv_path.read_text(encoding="utf-8")) or {}
    for key, val in walk(lv):
        full = f"plugins.local_voice.{key}"
        rows.append(
            (
                full,
                typ(val),
                fmt_default(full, val),
                source_for(full),
                "server/modules/local_voice/config.yaml",
                "—",
                "current",
            )
        )

    lines = [
        "# Config keys inventory (Stage 1c)\n",
        "\n",
        "> One row per leaf key. Defaults from tracked `*.example.yaml` only (not invented).\n",
        "> Loader: `config/*.yaml` → short root → `modules/*/config.yaml` → env secrets → "
        "resolved memory paths → schema.\n",
        "\n",
        "## `local_voice` merge\n",
        "\n",
        "| Item | Value |\n",
        "|---|---|\n",
        "| Module file | `server/modules/local_voice/config.yaml` |\n",
        "| Consumer | `merge_plugin_configs` → `config.plugins.local_voice` |\n",
        "| Stub reader | `stub.py` → `plugins.local_voice.wake_word` |\n",
        "| Compatibility | Shallow merge; module overlay wins |\n",
        "\n",
        "## Leaf keys\n",
        "\n",
        "| Key | Type | Default (example) | Source | Target file | Env override | Compatibility |\n",
        "|---|---|---|---|---|---|---|\n",
    ]
    for key, t, d, source, target, env, compat in rows:
        lines.append(
            f"| `{key}` | {t} | {d} | {source} | `{target}` | {env} | {compat} |\n"
        )
    lines.extend(
        [
            "\n",
            "## Legacy / aliases\n",
            "\n",
            "| Item | Behavior |\n",
            "|---|---|\n",
            "| Deep keys still in short `server/config.yaml` | Merged with warning "
            "`legacy root deep key …` |\n",
            "| `YANDEX_ID_KEY` | Alias for `YANDEX_FOLDER_ID`; warning once |\n",
            "| `HUGGING_FACE_HUB_TOKEN` | Alias for `HF_TOKEN`; warning once |\n",
            "\n",
            "## Module overlays\n",
            "\n",
            "| Module | Merged as |\n",
            "|---|---|\n",
            "| `modules/discord/config.yaml` | top-level `discord` |\n",
            "| `modules/internal_api/config.yaml` | `internal_api`, `dashboard` "
            "(overrides `server.yaml`) |\n",
            "| other `modules/<id>/config.yaml` | `plugins.<id>` |\n",
        ]
    )
    OUT.write_text("".join(lines), encoding="utf-8")
    print(f"wrote {OUT} rows={len(rows)}")


if __name__ == "__main__":
    main()
