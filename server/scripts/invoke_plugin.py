#!/usr/bin/env python3
"""
Разовый запуск плагина по id из корня проекта (отладка on_demand-плагинов).

Пример:
  python scripts/invoke_plugin.py hello_world

Основной рабочий путь — ядро (`python main.py`): resident-плагины стартуют сами.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Invoke one plugin by manifest id (dev helper).")
    parser.add_argument("plugin_id", help="plugin.yaml id field")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    from core.plugins.loader import PluginLoader
    from core.plugins.sdk import PluginContext, run_plugin_entrypoint

    loader = PluginLoader(root)
    manifest = None
    for m in loader.discover_manifests():
        if m.id == args.plugin_id:
            manifest = m
            break
    if not manifest:
        print(f"No plugin with id={args.plugin_id!r}", file=sys.stderr)
        return 1
    if not manifest.enabled:
        print(f"Plugin {args.plugin_id} is disabled in plugin.yaml", file=sys.stderr)
        return 1
    if manifest.id == "internal_api":
        print("internal_api is started by the core process: python main.py", file=sys.stderr)
        return 1

    import yaml

    cfg_path = root / "config.yaml"
    if not cfg_path.is_file():
        print("config.yaml not found", file=sys.stderr)
        return 1
    from core.plugins.config import merge_plugin_configs
    from core.runtime.secrets import apply_env_secrets, load_dotenv_file

    load_dotenv_file(root)
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    if not isinstance(cfg, dict):
        cfg = {}
    merge_plugin_configs(cfg, root)
    apply_env_secrets(cfg)

    agent = None
    if manifest.id == "discord":
        from core.neyra import NeyraAgent

        agent = NeyraAgent(cfg)

    mod = loader.import_plugin_module(manifest)
    ctx = PluginContext(root=root, config=cfg, agent=agent)
    run_plugin_entrypoint(mod, ctx)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
