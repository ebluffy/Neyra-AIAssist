![Cursor](https://img.shields.io/badge/Cursor-%23000000?style=for-the-badge&logo=Cursor&logoColor=white)

---

# Neyra - AIAssist

Modular personal AI assistant: local **Neyra Server** + optional Windows control client.

**Repository:** [github.com/ebluffy/Neyra-AIAssist](https://github.com/ebluffy/Neyra-AIAssist)

**Russian overview:** [README-RU.md](README-RU.md) · **Roadmap:** [docs/PLAN.md](docs/PLAN.md) · **Docs index:** [docs/en/README.md](docs/en/README.md)

## Overview

- Stable core: LLM (four roles), memory, reflection, tools, Event Bus
- Dual providers via `server/config/llm.yaml` (e.g. talk → OpenRouter, brain/memory/vision → AIHope)
- Control API in `server/core/api/` (REST + WebSocket chat) — not a plugin
- Plugins under `server/modules/` (`discord`, `local_voice`, template `000EXAMPLE`)
- Server web dashboard in `server/dashboard/` (React + Vite + Tailwind; access-key gate)
- Dev MCP in `devtools/mcp_server/` (Cursor debug; not part of runtime packages)
- Product Windows client scaffold in `client/` (Tauri MVP = Stage 3)

## Layout

```text
server/          # core, modules, dashboard, config, scripts, data, logs
client/          # Tauri control app (scaffold until Stage 3)
devtools/        # MCP debug server
docs/            # PLAN, config-keys, EN/RU guides, ADRs
```

## Quick start

1. `python -m venv .venv` and activate (Windows: `.venv\Scripts\activate`)
2. `pip install -r server/requirements.txt`
3. Copy `server/.env.example` → `server/.env` and fill secrets (`OPENROUTER_API_KEY` / `AIHOPE_API_KEY`, Discord token if needed)
4. Copy `server/config.example.yaml` → `server/config.yaml`
5. Copy layers: `server/config/*.example.yaml` → `server/config/*.yaml`
6. Optional plugins: `server/modules/<id>/config.example.yaml` → `config.yaml`
7. Dashboard build: `cd server/dashboard && npm install && npm run build`
8. Run: `cd server && python main.py` (or `run_neyra.bat` / `./run_neyra.sh` from repo root)

Default API: `http://127.0.0.1:8787` · OpenAPI: `/docs`

Docker: `docker compose up --build` (root compose includes `server/`).

## Configuration

| What | Where |
|------|--------|
| Short root (`paths`, `system`, `assistant`) | `server/config.yaml` |
| Layers (llm, agent, memory, voice, modules, runtime, server) | `server/config/*.yaml` |
| HTTP bind, public URL, dashboard | `server/config/server.yaml` (`api:`, `dashboard:`) |
| Secrets | `server/.env` only |
| Key inventory | [docs/config-keys.md](docs/config-keys.md) |

No legacy dual-read: use `llm.talk_model` / `llm.brain_model` / … with `provider` — not top-level `BACKEND` or `openrouter:`.

## Dashboard

SPA served by the Control API from `server/dashboard/dist`.

- First visit: create an access key (≥ 8 characters, or hex-32). Hash stored with PBKDF2 in SQLite under `server/data/`.
- Later visits: login with that key. On non-loopback bind, initial setup is allowed only from a loopback client.
- Separate from API Bearer tokens (`API_TOKEN` / viewer / maint).

## Models (four roles)

Configured in `server/config/llm.yaml`:

- **talk** — user-facing stream (no tools)
- **brain** — supervisor / tool-loop (MCP-aware)
- **memory** — reflection, diary, LTM summarization
- **vision** — VL captioning

## Plugins / Discord

Shipped modules: `discord` (text + Lavalink music), `local_voice` (stub), `000EXAMPLE` (SDK template).

Enable/disable only via `plugin.yaml`. Settings in `server/modules/<id>/config.yaml`. Lavalink JAR: `python server/scripts/fetch_lavalink.py` (not in git).

Plugin SDK: [HELP.md](server/modules/000EXAMPLE/HELP.md) · [HELP-RU.md](server/modules/000EXAMPLE/HELP-RU.md)

## Client (Stage 3)

`client/` is scaffold only. Stage 3 adds Tauri 2 + React MVP (Connect / Chat / Status / Modules) and public host `https://neyra.owyx.site` via frp (home server → VPS). See [docs/PLAN.md](docs/PLAN.md) §3.

## Status vs roadmap

| Done | Next |
|------|------|
| Layout 1b, config layers 1c, dual LLM 1d, Control API Wave 1, dashboard gate | Stage 3 Windows client + domain publish |

## Support

Crypto donations (verify network before sending):

- **TON / USDT (TON):** `UQD6p87_YQNeZmGduBHnkWBF3AbvyNOwt_xt8fn1Vd3zBSYa`
- **USDT (TRC20):** `TU467q2tsQLH58u6KVh3LyGwx7sqn2WyPQ`
- **USDT (ERC20) / ETH:** `0xf834f04668b947eeb56b433c54173f311a06392a`
- **BTC:** `bc1qevu7yty2l4u3n54gjkvj9nrtypj303ejd7e0z3`

Core stays MIT regardless of donations.

## AI-assisted development

Architecture and integration are human-directed; much scaffolding was written with AI coding agents. Reviews and PRs are welcome.

## License

MIT (see `LICENSE`).
