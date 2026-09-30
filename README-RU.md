![Cursor](https://img.shields.io/badge/Cursor-%23000000?style=for-the-badge&logo=Cursor&logoColor=white)

---

# Neyra - AIAssist

Модульный персональный ИИ-ассистент: локальный **Neyra Server** и опциональный Windows-клиент управления.

**Репозиторий:** [github.com/ebluffy/Neyra-AIAssist](https://github.com/ebluffy/Neyra-AIAssist)

**English:** [README.md](README.md) · **План:** [docs/PLAN.md](docs/PLAN.md) · **Документация:** [docs/ru/README.md](docs/ru/README.md)

## Обзор

- Стабильное ядро: LLM (четыре роли), память, рефлексия, инструменты, Event Bus
- Dual-провайдеры через `server/config/llm.yaml` (например talk → OpenRouter, brain/memory/vision → AIHope)
- Control API в `server/core/api/` (REST + WebSocket-чат) — не плагин
- Плагины в `server/modules/` (`discord`, `local_voice`, шаблон `000EXAMPLE`)
- Веб-дашборд сервера в `server/dashboard/` (React + Vite + Tailwind; gate по access key)
- Dev MCP в `devtools/mcp_server/` (отладка в Cursor; не часть runtime-пакетов)
- Продуктовый Windows-клиент — scaffold в `client/` (MVP = Этап 3)

## Структура

```text
server/          # ядро, модули, dashboard, конфиг, скрипты, data, logs
client/          # Tauri control app (scaffold до Этапа 3)
devtools/        # MCP debug-сервер
docs/            # PLAN, config-keys, EN/RU гайды, ADR
```

## Быстрый старт

1. `python -m venv .venv` и активация (Windows: `.venv\Scripts\activate`)
2. `pip install -r server/requirements.txt`
3. `server/.env.example` → `server/.env`, заполнить секреты
4. `server/config.example.yaml` → `server/config.yaml`
5. Слои: `server/config/*.example.yaml` → `server/config/*.yaml`
6. При необходимости: `server/modules/<id>/config.example.yaml` → `config.yaml`
7. Дашборд: `cd server/dashboard && npm install && npm run build`
8. Запуск: `cd server && python main.py` (или `run_neyra.bat` / `./run_neyra.sh`)

API по умолчанию: `http://127.0.0.1:8787` · OpenAPI: `/docs`

Docker: `docker compose up --build`.

## Конфигурация

| Что | Где |
|-----|-----|
| Короткий корень | `server/config.yaml` |
| Слои | `server/config/*.yaml` |
| Bind, public URL, dashboard | `server/config/server.yaml` (`api:`, `dashboard:`) |
| Секреты | только `server/.env` |
| Инвентарь ключей | [docs/config-keys.md](docs/config-keys.md) |

Без legacy dual-read: роли `llm.*_model` с полем `provider` — не top-level `BACKEND` / `openrouter:`.

## Дашборд

SPA раздаётся Control API из `server/dashboard/dist`.

- Первый визит: создать access key (≥ 8 символов или hex-32). Хеш PBKDF2 в SQLite под `server/data/`.
- Далее — логин. При bind не на loopback первичная настройка только с loopback-клиента.
- Отдельно от API Bearer (`API_TOKEN` / viewer / maint).

## Модели

В `server/config/llm.yaml`: **talk**, **brain**, **memory**, **vision**.

## Плагины

Поставляются: `discord` (текст + Lavalink), `local_voice`, `000EXAMPLE`.

Вкл/выкл — только `plugin.yaml`. Lavalink JAR: `python server/scripts/fetch_lavalink.py`.

SDK: [HELP-RU.md](server/modules/000EXAMPLE/HELP-RU.md) · [HELP.md](server/modules/000EXAMPLE/HELP.md)

## Клиент (Этап 3)

`client/` — только scaffold. Этап 3: Tauri 2 + React (Connect / Chat / Status / Modules) и публикация `https://neyra.owyx.site` через frp (домашний сервер → VPS). См. [docs/PLAN.md](docs/PLAN.md) §3.

## Статус

| Закрыто | Дальше |
|---------|--------|
| 1b layout, 1c конфиг, 1d dual LLM, Stage 2 API Wave 1, dashboard gate | Этап 3 клиент + хостинг домена |

## Поддержка

Крипто (проверяйте сеть):

- **TON / USDT (TON):** `UQD6p87_YQNeZmGduBHnkWBF3AbvyNOwt_xt8fn1Vd3zBSYa`
- **USDT (TRC20):** `TU467q2tsQLH58u6KVh3LyGwx7sqn2WyPQ`
- **USDT (ERC20) / ETH:** `0xf834f04668b947eeb56b433c54173f311a06392a`
- **BTC:** `bc1qevu7yty2l4u3n54gjkvj9nrtypj303ejd7e0z3`

Ядро остаётся MIT независимо от донатов.

## ИИ в разработке

Архитектура и интеграция — под управлением человека; значительная часть реализации — с AI-агентами. Issue и PR приветствуются.

## Лицензия

MIT (см. `LICENSE`).
