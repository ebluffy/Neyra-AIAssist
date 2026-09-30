<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Configuration model

## Sources

1. Root `server/config.yaml` (assistant, paths, high-level toggles).
2. Layer files under `server/config/*.yaml` (llm, agent, memory, voice, modules, runtime, **server**).
3. Plugin files `server/modules/<id>/config.yaml`.
4. Secrets `server/.env`.

## Merge order

1. Load `server/config.yaml` and layered YAML from `server/config/`.
2. `merge_plugin_configs(...)` merges plugin configs.
3. `apply_env_secrets(...)` overlays secrets from the environment.

## Rules

- Plugin folder `discord` → top-level key `discord` in the merged dict.
- HTTP Control API and dashboard → `server/config/server.yaml` (`api:`, `dashboard:`); implementation in `server/core/api/` (not a plugin).
- Other plugin ids → `plugins.<id>`.

See also [config-reference](../setup/config-reference.md) and `docs/config-keys.md`.
