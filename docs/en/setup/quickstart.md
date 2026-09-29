<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Quickstart

1. Создайте venv и установите зависимости:
   - `python -m venv .venv`
   - `.venv\\Scripts\\activate` (Windows)
   - `pip install -r requirements.txt`
2. Copy `.env.example` → `.env` and fill secrets (under `server/`).
3. Copy short root: `config.example.yaml` → `config.yaml`.
4. Copy layers: `config/*.example.yaml` → `config/*.yaml` (llm, agent, memory, voice, modules, runtime, server). See `docs/config-keys.md`.
5. For plugins copy:
   - `modules/discord/config.example.yaml` → `modules/discord/config.yaml`
   - `modules/internal_api/config.example.yaml` → `modules/internal_api/config.yaml`
6. (optional) dashboard:
   - `cd dashboard && npm install && npm run build`
7. Run from `server/`:
   - `python main.py`
