<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Quickstart

1. Создайте venv и установите зависимости (из корня репозитория):
   - `python -m venv .venv_win` (Windows) или `.venv` (Linux/macOS)
   - активируйте venv
   - `pip install -r server/requirements.txt`
2. Скопируйте `server/.env.example` → `server/.env` и заполните секреты.
3. Короткий корневой конфиг: `server/config.example.yaml` → `server/config.yaml`.
4. Слои: `server/config/*.example.yaml` → `server/config/*.yaml` (llm, agent, memory, voice, modules, runtime, server). См. `docs/config-keys.md`.
5. Discord и server-слой:
   - `server/modules/discord/config.example.yaml` → `server/modules/discord/config.yaml`
   - `server/config/server.example.yaml` → `server/config/server.yaml` (bind API + `api.public_*`, `dashboard:`)
6. (опционально) dashboard:
   - `cd server/dashboard && npm install && npm run build`
7. Запуск ядра:
   - из корня репо: `python server/main.py`, или из cwd `server/`: `python main.py`
8. Откройте `http://127.0.0.1:8787/` — при первом визите задайте **ключ доступа к дашборду** (см. [web-ui](../architecture/web-ui.md)).

Дорожная карта: [`docs/PLAN.md`](../../PLAN.md) (этапы 1a–2 закрыты; Этап 3 = Tauri `client/` + публикация `neyra.owyx.site` через frp).
