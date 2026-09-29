![Cursor](https://img.shields.io/badge/Cursor-%23000000?style=for-the-badge&logo=Cursor&logoColor=white)

---

# Neyra - AIAssist

AI Assisted

**Repository:** [github.com/KORESHon/Neyra-AIAssist](https://github.com/KORESHon/Neyra-AIAssist)

Modular AI assistant platform with a core-first architecture.

## Overview

Neyra is designed as a reusable assistant core plus pluggable integrations.

Key goals:

- stable core (`LLM + Memory + Reflection + Tools`),
- provider-agnostic model backends with **four specialized roles** (talk / brain / memory / vision),
- event-driven integrations, webhooks, and **MCP-native** extensibility,
- plugin-style extensibility without rewriting the core,
- local-first runtime with optional cloud providers.

Current stable runtime:

- `**python server/main.py`** — core: HTTP API, web dashboard, one `NeyraAgent`, resident plugins (e.g. Discord when enabled),
- `**python server/main.py --mode console`** — terminal-only for prompt experiments,
- `discord` (text + music) and other interfaces ship as plugins under `server/modules/`,
- optional **Docker** via root `docker-compose.yml` (includes `server/`).

### Dashboard (frontend)

Web UI: **React + Vite + Tailwind CSS** under `server/dashboard/`. Production build outputs to `server/dashboard/dist` and is served by Internal API (`npm install && npm run build` before shipping).

### MCP debug (IDE tooling)

Optional **Model Context Protocol** debug server in `devtools/mcp_server/` (stdio MCP for Cursor): tail logs, issue Internal API requests, inject Event Bus events (`POST /v1/debug/fire_event`), inspect memory snapshots. Configure via `docs/en/setup/mcp-debug-server.md`.

### Discord and music

Single resident plugin `**server/modules/discord/`** (text gateway + music service). Music path uses **Lavalink 4.x** with up-to-date **YouTube / source plugins**; deployments often set Lavalink client identifiers such as **ANDROID_VR** where needed to avoid provider-side breakage.

### Models — four roles, nested config

Fully driven by `server/config/llm.yaml` under `llm.talk_model`, `brain_model`, `memory_model`, `vision_model` (each role sets `provider`):

- **talk** — final user-facing responses (streamed, no tools),
- **brain** — supervisor/tool-loop with `bind_tools` (MCP-aware),
- **memory** — reflection, diary analysis, LTM summarization,
- **vision** — VL captioning (single model via `llm.vision_model`).

Typical dual stack: talk on OpenRouter (e.g. free Qwen), brain/memory/vision on AIHope. Keys: `OPENROUTER_API_KEY` / `AIHOPE_API_KEY` in `.env` → `llm.providers.*`.

## Architecture at a glance

- `core/` — model profiles, memory (STM/LTM/PeopleDB/Diary), reflection, tools, secrets loader.
  - `core/mcp_client.py` — **MCP client manager** (stdio + SSE servers, dynamic LangChain tools).
  - `core/ltm_maintenance.py` — LTM lifecycle: TTL prune, summarization → cold archive.
  - `core/voice/` — voice adapters and factories (cloud/local evolution path).
- `server/dashboard/` — React+Vite+Tailwind sources; production bundle in `server/dashboard/dist`.
- `server/modules/` — plugins (`server/modules/<id>/plugin.yaml` + `main.py`); shipped: `**discord`** (unified text+music), `internal_api`, `local_voice`; template `**000EXAMPLE/`** (see Plugin SDK links below).
- `devtools/mcp_server/` — **MCP debug server** (stdio MCP for Cursor): logs, API calls, fire_event, memory snapshot.
- `scripts/` — ops helpers (health checks, maintenance, `inject_memes_2026.py`).
- `main.py` — entrypoint (`core` vs `console` only).
- `run_neyra.bat` — Windows menu (core / console / preflight).
- `run_neyra.sh` — Linux/macOS menu (core / console / status / stop / git updates).
- `docker-compose.yml` (root) + `server/Dockerfile` — container deploy (port `8787`, volumes under `server/`).

## Product direction

Neyra is moving toward a public personal-assistant platform:

- desktop assistant app (OS command automation with strict safety controls),
- mobile-lite chat client via API,
- micro web dashboard with status, controls, and API docs,
- external storage adapters (Google Drive-first) for backup/restore,
- modular expansion (voice/screen/music/plugins),
- **MCP-native integrations** — external capabilities via standard Model Context Protocol servers,
- **vision pipeline** — screen understanding via VL models (caption → brain tool-loop → talk response).

Long-term hardware "assistant station" form factor is tracked as a future backlog item.

## Quick start

### Python (direct)

1. Create and activate venv:
  - `python -m venv .venv`
  - Windows: `.venv\Scripts\activate`
  - Linux/macOS: `source .venv/bin/activate`
2. Install dependencies:
  - `pip install -r server/requirements.txt`
3. Create `server/.env` from `server/.env.example` and fill secrets.
4. Create `server/config.yaml` from `server/config.example.yaml` (short root: `paths`, `system`, `assistant`).
5. Copy layer templates: `server/config/*.example.yaml` → `server/config/*.yaml` (llm, agent, memory, voice, modules, runtime, server). Set models under `server/config/llm.yaml` (`llm.talk_model` / `brain_model` / …).
6. Copy plugin templates where needed:
  - `server/modules/discord/config.example.yaml` → `server/modules/discord/config.yaml`
  - `server/modules/internal_api/config.example.yaml` → `server/modules/internal_api/config.yaml`
  - other plugins: `server/modules/<id>/config.example.yaml` → `server/modules/<id>/config.yaml`
7. Preflight (example): `cd server && python scripts/healthcheck.py --mode console --skip-http`
8. Run:
  - Windows: `run_neyra.bat`
  - Linux/macOS: `chmod +x run_neyra.sh && ./run_neyra.sh`
  - Direct: `cd server && python main.py` (core) or `python main.py --mode console`

### Docker (optional)

```bash
docker compose up --build
```

Exposes port `8787`; runtime files live under `server/` (`config.yaml`, `modules/`, `data/memory/`, `logs/`).

## Run modes (CLI)

- `**core`** (default) — HTTP API, dashboard, resident plugins.
- `**console`** — terminal chat only.

Plugins start **with** the core from root `config.yaml`, optional per-plugin `server/modules/<id>/config.yaml`, and `**plugin.yaml`** (enable/disable and lifecycle only there). There is no separate `--mode discord` CLI.

## Environment variables

See `.env.example`.

Required for cloud model:

- `OPENROUTER_API_KEY`

Required when `discord` is enabled in `server/modules/discord/plugin.yaml`:

- `DISCORD_TOKEN` in `.env` (optional legacy: `discord.token` merged from old configs)

Optional (future voice integrations):

- `DEEPGRAM_API_KEY`
- `GROQ_API_KEY`
- `YANDEX_API_KEY`
- `YANDEX_FOLDER_ID`

## Configuration files

- Short root template: `server/config.example.yaml` → `server/config.yaml` (`paths`, `system`, `assistant`)
- Layer templates: `server/config/*.example.yaml` → `server/config/*.yaml` (see `docs/config-keys.md`)
- Plugin settings: `server/modules/<plugin_id>/config.yaml` (optional; copy from `config.example.yaml` in that folder). HTTP bind + dashboard: `server/modules/internal_api/config.yaml` (overrides `server/config/server.yaml`).
- Secret values: `server/.env` (ignored by git)

## System prompts and behavior tuning

Primary places to edit prompt behavior:

- Base assistant prompt (main personality/instructions):
  - `config.yaml` -> `assistant.system_prompt`
- Final system prompt assembly (injects memory, tools, web context, vision rules):
  - `core/agent.py` (`_build_system_prompt`)
- Brain tool-loop and VL pipeline:
  - `core/agent.py` (`_run_brain_tool_phase`, `_caption_vision_images`, `chat` / `chat_stream`)
- Reflection prompts (nightly and hourly diary analysis):
  - `core/reflection.py` (`_analyze_diary_json`, `hourly_diary_note`)
- Tool behavior and tool-facing descriptions:
  - `core/tools.py`
- Memory-trigger and web-trigger heuristics that affect prompt context:
  - `core/agent.py` (`_collect_tool_context`, `_handle_websearch_trigger`)
- MCP client integration (dynamic tools from MCP servers):
  - `core/mcp_client.py`, `core/agent.py` (`start_mcp_clients`, `_execute_tool`)

Recommendation:

- Keep production persona details only in local `config.yaml`.
- Keep `config.example.yaml` generic for public repository sharing.

## Planning and documentation files

- `README.md` - public product/technical overview (English).
- `README-RU.md` - public product/technical overview (Russian).
- `PLAN.md` - roadmap: Hub/core + agent/voice improvements done; active focus — Web UI Event Bus bridge, then autonomous server/column.
- `docs/en/README.md` / `docs/ru/README.md` - documentation index (architecture, setup, API, ops, usage, plugins, MCP, Web UI).
- **Plugin SDK (tutorial & reference)** — [HELP.md (English)](server/modules/000EXAMPLE/HELP.md) · [HELP-RU.md (Русский)](server/modules/000EXAMPLE/HELP-RU.md).

## Notes

- Voice bot in Discord VC is intentionally not part of current stable runtime.
- Runtime logs and memory artifacts are ignored by git (see `.gitignore`).

## Support the project

If you like Neyra and want to support its development (or just buy the author a coffee), you can send cryptocurrency. The addresses below match wallets used in Trust Wallet and Telegram (TG) Wallet.

- **TON (network: TON):** `UQD6p87_YQNeZmGduBHnkWBF3AbvyNOwt_xt8fn1Vd3zBSYa`
- **USDT (network: TON):** `UQD6p87_YQNeZmGduBHnkWBF3AbvyNOwt_xt8fn1Vd3zBSYa`
- **USDT (network: TRC20):** `TU467q2tsQLH58u6KVh3LyGwx7sqn2WyPQ`
- **USDT (network: ERC20):** `0xf834f04668b947eeb56b433c54173f311a06392a`
- **ETH (Ethereum Mainnet):** `0xf834f04668b947eeb56b433c54173f311a06392a`
- **BTC (Bitcoin Network):** `bc1qevu7yty2l4u3n54gjkvj9nrtypj303ejd7e0z3`

*Always verify the network before sending. Thank you for your support 🚀*

The core stays open source under the MIT license regardless of donations.

## AI-assisted development

This project is a practical exploration of **prompt engineering** and how complex AI systems can be steered in a real codebase.

- **Architecture, system design, and module integration** are intentionally driven by a human.
- **Routine code, scaffolding, and much of the implementation** were written with heavy use of AI coding agents (Cursor, LLM assistants).

I believe the future of building software is the synergy between a human **architect** and AI-assisted **implementation**. If you find rough or suboptimal generated patches, open an Issue or a PR—reviews from experienced developers are genuinely welcome.

## License

MIT (see `LICENSE`).
