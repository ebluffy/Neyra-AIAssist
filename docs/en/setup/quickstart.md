<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Quickstart

1. Create a venv and install dependencies (from repo root):
   - `python -m venv .venv_win` (Windows) or `.venv` (Linux/macOS)
   - activate the venv
   - `pip install -r server/requirements.txt`
2. Copy `server/.env.example` → `server/.env` and fill secrets.
3. Copy short root config: `server/config.example.yaml` → `server/config.yaml`.
4. Copy layers: `server/config/*.example.yaml` → `server/config/*.yaml` (llm, agent, memory, voice, modules, runtime, server). See `docs/config-keys.md`.
5. For Discord and the server layer:
   - `server/modules/discord/config.example.yaml` → `server/modules/discord/config.yaml`
   - `server/config/server.example.yaml` → `server/config/server.yaml` (API bind + `api.public_*`, `dashboard:`)
6. (Optional) dashboard:
   - `cd server/dashboard && npm install && npm run build`
7. Run the core:
   - from repo root: `python server/main.py`, or from `server/` cwd: `python main.py`
8. Open `http://127.0.0.1:8787/` — on first visit, set the **dashboard access key** (see [web-ui](../architecture/web-ui.md)).

Roadmap: [`docs/PLAN.md`](../../PLAN.md) (Stages 1a–2 complete; Stage 3 = Tauri `client/` + public publish).
