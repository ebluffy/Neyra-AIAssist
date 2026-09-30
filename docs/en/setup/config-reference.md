<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# `server/config.yaml` reference

`server/config.yaml` holds only the short root runtime config for the core (assistant, paths, pointers to layers).

## Key sections

- `assistant` — `name`, `persona_path` / `appearance_path` (persona pack), `system_prompt` fallback
- `paths.data_dir` — runtime data root (default `server/data` from repo root; override `NEYRA_DATA_DIR`)
- `agent.fast_path` — regex allowlist for home commands (off by default; publishes `home.*`; multi-client e2e → Stage 3+)
- Layer files under `server/config/` — see `docs/config-keys.md` for full keys:
  - `llm.yaml` — per-role **`talk_model`**, **`brain_model`**, **`memory_model`**, **`vision_model`** with **`provider`**; providers under **`llm.providers.<name>`**. No top-level `BACKEND` / `openrouter:` / `vision:`.
  - `memory.yaml`, `voice.yaml`, `agent.yaml`, `modules.yaml`, `runtime.yaml`

## Moved out of the root file

- `discord` → `server/modules/discord/config.yaml`
- `api`, `dashboard` → `server/config/server.yaml` (sections `api:` and `dashboard:`)
- Other plugin settings → `server/modules/<id>/config.yaml`

## Do not store in YAML

- API keys and tokens. Use `server/.env`.
