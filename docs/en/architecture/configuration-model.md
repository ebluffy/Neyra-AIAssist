# Configuration model

## Sources

1. Root `server/config.yaml` (assistant, paths, high-level toggles).
2. Layer files under `server/config/*.yaml` (llm, agent, memory, voice, modules, runtime, **server**).
3. Plugin files `server/modules/<id>/config.yaml`.
4. Secrets `server/.env`.

## Merge order

1. Layer files `server/config/*.yaml` (`LAYER_FILES`) load first, in list order; a later layer overrides an earlier one.
2. The root `server/config.yaml` is applied **on top of** the layers: it overrides `config/*.yaml`, not the other way around (`core/runtime/config_loader.py:103-131`). Deep keys in the root (`llm:`, `memory:` and so on) count as legacy — startup logs a warning naming the layer they belong to.
3. `merge_plugin_configs(...)` merges plugin configs.
4. `apply_env_secrets(...)` overlays secrets from the environment.

## Rules

- Plugin folder `discord` → top-level key `discord` in the merged dict.
- HTTP Control API and dashboard → `server/config/server.yaml` (`api:`, `dashboard:`); implementation in `server/core/api/` (not a plugin).
- Other plugin ids → `plugins.<id>`.

See also [config-reference](../setup/config-reference.md); defaults: `server/config/*.example.yaml`; full keys: `python server/scripts/regen_config_keys_md.py` from the repo root (prints to stdout).
