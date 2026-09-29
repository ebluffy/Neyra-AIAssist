<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Архитектура Neyra

Neyra состоит из стабильного ядра и плагинов в `server/modules/`.

## Слои
- `core/`: агент, память, рефлексия, event bus, health monitor.
- `server/modules/internal_api/`: HTTP API + WebSocket + статическая раздача SPA (`server/dashboard/dist`, React + Vite + Tailwind).
- `server/modules/discord/`: единый resident-плагин Discord (текст + музыка через Lavalink 4.x, события `MUSIC_*` на шине).
- `server/modules/*`: прочие расширения через Plugin SDK.

Опционально для IDE: MCP debug-сервер в `devtools/mcp_server/` (логи, вызовы `/v1`, инъекция событий) — см. `docs/en/setup/mcp-debug-server.md`.

## Поток данных
1. `main.py` загружает `config.yaml`.
2. `core/plugins/config.py` подмешивает `server/modules/<id>/config.yaml`.
3. `core/secrets_loader.py` подставляет секреты из `.env`.
4. `core/runtime/server.py` запускает FastAPI и resident-плагины.
5. UI и внешние клиенты работают через `/v1` и `/v1/ws/*`.

## Принципы
- Вкл/выкл плагина: только `plugin.yaml`.
- Настройки плагина: `server/modules/<id>/config.yaml`.
- Секреты: только `.env`.