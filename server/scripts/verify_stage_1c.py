#!/usr/bin/env python3
"""Stage 1c acceptance: layered config, schema, local_voice merge smoke."""

from __future__ import annotations

import shutil
import sys
import tempfile
import warnings
import re
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVER_ROOT.parent

LAYER_NAMES = (
    "llm.yaml",
    "agent.yaml",
    "memory.yaml",
    "voice.yaml",
    "modules.yaml",
    "runtime.yaml",
    "server.yaml",
)


def _ensure_server_path() -> None:
    if str(SERVER_ROOT) not in sys.path:
        sys.path.insert(0, str(SERVER_ROOT))


def check_example_layers() -> list[str]:
    errs: list[str] = []
    cfg_dir = SERVER_ROOT / "config"
    if not cfg_dir.is_dir():
        return ["server/config/ directory missing"]
    for name in LAYER_NAMES:
        ex = cfg_dir / name.replace(".yaml", ".example.yaml")
        if not ex.is_file():
            errs.append(f"missing {ex.relative_to(REPO_ROOT)}")
    root_ex = SERVER_ROOT / "config.example.yaml"
    if not root_ex.is_file():
        errs.append("missing server/config.example.yaml")
        return errs
    text = root_ex.read_text(encoding="utf-8")
    deep_re = re.compile(
        r"^(BACKEND|openrouter|vision|llm|agent|memory|backup|external_storage|"
        r"voice|mcp_client|logging|health_monitor|internal_api|dashboard)\s*:"
    )
    for i, line in enumerate(text.splitlines(), 1):
        if deep_re.match(line):
            errs.append(f"root example still has deep key at line {i}: {line.strip()[:80]}")
    for key in ("paths:", "system:", "assistant:"):
        if not any(line.startswith(key) for line in text.splitlines()):
            errs.append(f"root example missing {key}")
    return errs


def check_loader_from_examples() -> list[str]:
    _ensure_server_path()
    from core.runtime.config_loader import (
        load_layered_config,
        load_layered_yaml,
        validate_config_schema,
    )

    errs: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "config").mkdir()
        shutil.copy2(SERVER_ROOT / "config.example.yaml", root / "config.yaml")
        for name in LAYER_NAMES:
            src = SERVER_ROOT / "config" / name.replace(".yaml", ".example.yaml")
            shutil.copy2(src, root / "config" / name)
        (root / "modules").mkdir()

        cfg = load_layered_yaml(root)
        llm = cfg.get("llm") if isinstance(cfg.get("llm"), dict) else {}
        if not isinstance(llm.get("talk_model"), dict):
            errs.append("llm.talk_model missing after layer load")
        if not isinstance(cfg.get("memory"), dict):
            errs.append("memory missing after layer load")
        if not isinstance(cfg.get("assistant"), dict):
            errs.append("assistant missing after layer load")
        if not isinstance((cfg.get("paths") or {}).get("data_dir"), str):
            errs.append("paths.data_dir missing")

        schema_errs = validate_config_schema(cfg)
        if schema_errs:
            errs.extend(f"schema(pre): {e}" for e in schema_errs)

        full = load_layered_config(root, validate=True)
        mem = full.get("memory") or {}
        data_root = (root / "data").resolve()
        mem_root = (data_root / "memory").resolve()
        for key in ("sqlite_path", "chroma_db_path"):
            raw = str(mem.get(key) or "").strip()
            if not raw:
                errs.append(f"memory.{key} empty after full load")
                continue
            resolved = Path(raw).resolve()
            try:
                resolved.relative_to(mem_root)
            except ValueError:
                errs.append(
                    f"memory.{key}={resolved} not under expected {mem_root}"
                )
        paths = full.get("paths") or {}
        if not paths.get("data_dir"):
            errs.append("paths.data_dir empty after full load")
    return errs


def check_neyra_data_dir_override() -> list[str]:
    _ensure_server_path()
    import os

    from core.runtime.config_loader import load_layered_config

    errs: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        custom_data = root / "custom_data"
        (root / "config").mkdir()
        shutil.copy2(SERVER_ROOT / "config.example.yaml", root / "config.yaml")
        for name in LAYER_NAMES:
            src = SERVER_ROOT / "config" / name.replace(".yaml", ".example.yaml")
            shutil.copy2(src, root / "config" / name)
        (root / "modules").mkdir()

        prev = os.environ.get("NEYRA_DATA_DIR")
        os.environ["NEYRA_DATA_DIR"] = str(custom_data)
        try:
            full = load_layered_config(root, validate=True)
        finally:
            if prev is None:
                os.environ.pop("NEYRA_DATA_DIR", None)
            else:
                os.environ["NEYRA_DATA_DIR"] = prev

        mem = full.get("memory") or {}
        mem_root = (custom_data.resolve() / "memory").resolve()
        for key in ("sqlite_path", "chroma_db_path"):
            raw = str(mem.get(key) or "").strip()
            if not raw:
                errs.append(f"NEYRA_DATA_DIR: memory.{key} empty")
                continue
            resolved = Path(raw).resolve()
            try:
                resolved.relative_to(mem_root)
            except ValueError:
                errs.append(
                    f"NEYRA_DATA_DIR: memory.{key}={resolved} not under {mem_root}"
                )
    return errs


def check_legacy_root_warning() -> list[str]:
    _ensure_server_path()
    from core.runtime.config_loader import load_layered_yaml

    errs: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "config").mkdir()
        (root / "config" / "llm.yaml").write_text(
            "llm:\n  talk_model:\n    provider: openrouter\n    model: x\n",
            encoding="utf-8",
        )
        (root / "config.yaml").write_text(
            "paths:\n  data_dir: ./data\n"
            "assistant:\n  name: Test\n"
            "agent:\n  fast_path:\n    enabled: false\n",
            encoding="utf-8",
        )
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            cfg = load_layered_yaml(root)
        msgs = [str(w.message) for w in caught if issubclass(w.category, UserWarning)]
        if not any("legacy root deep key 'agent'" in m for m in msgs):
            errs.append(f"expected legacy root warning for agent, got {msgs!r}")
        if not isinstance(cfg.get("agent"), dict):
            errs.append("legacy agent not merged from root")
    return errs


def check_local_voice_merge() -> list[str]:
    _ensure_server_path()
    from core.plugins.config import merge_plugin_configs

    errs: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        mod = root / "modules" / "local_voice"
        mod.mkdir(parents=True)
        (mod / "config.yaml").write_text(
            "wake_word: testwake\ninput_device: mic1\noutput_device: out1\n",
            encoding="utf-8",
        )
        cfg: dict = {}
        merge_plugin_configs(cfg, root)
        lv = (cfg.get("plugins") or {}).get("local_voice") or {}
        for key in ("wake_word", "input_device", "output_device"):
            if key not in lv:
                errs.append(f"local_voice merge lost key {key}")
        if lv.get("wake_word") != "testwake":
            errs.append(f"wake_word expected testwake, got {lv.get('wake_word')!r}")
        # After layered load path: same merge on non-empty cfg
        cfg2 = {"plugins": {"local_voice": {"wake_word": "old"}}}
        merge_plugin_configs(cfg2, root)
        lv2 = (cfg2.get("plugins") or {}).get("local_voice") or {}
        if lv2.get("wake_word") != "testwake":
            errs.append("module config should override previous plugins.local_voice.wake_word")
        if lv2.get("input_device") != "mic1":
            errs.append("input_device missing after overlay merge")
    return errs


def check_schema_rejects_bad() -> list[str]:
    _ensure_server_path()
    from core.runtime.config_loader import validate_config_schema

    errs: list[str] = []
    bad = {"paths": {"data_dir": 1}, "assistant": "x"}
    got = validate_config_schema(bad)
    if not any("paths.data_dir" in e for e in got):
        errs.append(f"expected paths.data_dir type error, got {got}")
    if not any("assistant" in e for e in got):
        errs.append(f"expected assistant type error, got {got}")

    thin = {
        "paths": {"data_dir": "./data"},
        "assistant": {"name": "X"},
        "memory": {},
        "logging": {},
        "llm": {},
    }
    got2 = validate_config_schema(thin)
    for needle in (
        "logging.level",
        "logging.system_log",
        "llm.talk_model",
    ):
        if not any(needle in e for e in got2):
            errs.append(f"expected {needle} schema error, got {got2}")

    removed = {
        "paths": {"data_dir": "./data"},
        "assistant": {"name": "X"},
        "memory": {},
        "logging": {"level": "INFO", "system_log": "x"},
        "llm": {
            "talk_model": {"provider": "openrouter", "model": "x"},
        },
        "BACKEND": "aihope",
        "openrouter": {"model": "x"},
        "vision": {"enabled": True},
    }
    got3 = validate_config_schema(removed)
    for needle in ("BACKEND", "openrouter", "vision"):
        if not any(needle in e for e in got3):
            errs.append(f"expected removed-key schema error for {needle}, got {got3}")
    return errs


def check_deep_merge_preserves_layer_nested() -> list[str]:
    _ensure_server_path()
    from core.runtime.config_loader import load_layered_yaml

    errs: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "config").mkdir()
        (root / "config" / "llm.yaml").write_text(
            "llm:\n"
            "  talk_model:\n"
            "    provider: openrouter\n"
            "    model: layer-model\n"
            "    temperature: 0.7\n"
            "    timeout_seconds: 30\n",
            encoding="utf-8",
        )
        (root / "config.yaml").write_text(
            "paths:\n  data_dir: ./data\n"
            "assistant:\n  name: Test\n"
            "llm:\n"
            "  talk_model:\n"
            "    model: root-model\n",
            encoding="utf-8",
        )
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            cfg = load_layered_yaml(root)
        talk = ((cfg.get("llm") or {}).get("talk_model") or {})
        if talk.get("model") != "root-model":
            errs.append(f"root should win talk_model.model, got {talk.get('model')!r}")
        if talk.get("temperature") != 0.7:
            errs.append(f"layer temperature should survive deep merge, got {talk!r}")
        if talk.get("timeout_seconds") != 30:
            errs.append(f"layer timeout_seconds should survive deep merge, got {talk!r}")
    return errs


def main() -> int:
    checks = [
        ("example layers", check_example_layers),
        ("loader from examples", check_loader_from_examples),
        ("NEYRA_DATA_DIR override", check_neyra_data_dir_override),
        ("legacy root warning", check_legacy_root_warning),
        ("deep merge preserves nested", check_deep_merge_preserves_layer_nested),
        ("local_voice merge", check_local_voice_merge),
        ("schema rejects bad", check_schema_rejects_bad),
    ]
    failed = 0
    for name, fn in checks:
        try:
            errs = fn()
        except Exception as e:
            print(f"FAIL {name}: exception {e}")
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
    print("\nAll Stage 1c checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
