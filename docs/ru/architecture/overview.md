# Архитектура Neyra

Neyra — стабильное ядро плюс плагины в `server/modules/`.

## Слои

- `server/core/`: агент, память, рефлексия, event bus, health monitor.
- `server/core/api/`: HTTP Control API + WebSocket + статическая SPA (`server/dashboard/dist`, React + Vite + Tailwind).
- `server/modules/discord/`: resident-плагин Discord (текст + музыка через Lavalink 4.x, события `MUSIC_*` на шине).
- `server/modules/*`: прочие расширения через Plugin SDK (`local_voice`, `000EXAMPLE`, …).
- `server/config/*.yaml` + `server/config.yaml`: слоистая конфигурация; bind HTTP и настройки дашборда — в `server/config/server.yaml` (`api:`, `dashboard:`).
- `client/`: каркас Tauri 2 + React (продуктовый клиент Этапа 3; отдельно от `server/dashboard/`).
- `devtools/mcp_server/`: опциональный MCP для IDE (не входит в runtime-поставку).

## Поток данных

1. `server/main.py` загружает `server/config.yaml` и слои из `server/config/`.
2. `server/core/plugins/config.py` подмешивает `server/modules/<id>/config.yaml`.
3. `server/core/secrets_loader.py` подставляет секреты из `server/.env`.
4. `server/core/runtime/server.py` поднимает FastAPI (Control API) и resident-плагины.
5. Веб-дашборд, интеграции и будущий Tauri-клиент используют `/v1` и `/v1/ws/*`.

## Принципы

- Вкл/выкл плагина: только `server/modules/<id>/plugin.yaml`.
- Настройки плагина: `server/modules/<id>/config.yaml`.
- Секреты: только `server/.env`.
- Runtime-данные: `server/data/` (память — `server/data/memory/`), логи — `server/logs/`.

Опционально для IDE: MCP debug-сервер в `devtools/mcp_server/` — см. [mcp-debug-server](../setup/mcp-debug-server.md).
