![Cursor](https://img.shields.io/badge/Cursor-%23000000?style=for-the-badge&logo=Cursor&logoColor=white)

---

# Neyra - AIAssist

AI Assisted

**Репозиторий:** [github.com/KORESHon/Neyra-AIAssist](https://github.com/KORESHon/Neyra-AIAssist)

Модульная платформа ИИ-ассистента с приоритетом на стабильное ядро.

## Обзор

Neyra строится как переиспользуемое ядро плюс подключаемые интеграции.

Ключевые цели:

- стабильное ядро (`LLM + Memory + Reflection + Tools`),
- поддержка облачных и локальных backend,
- событийная интеграция, webhooks и **MCP-native** расширения,
- расширяемость через плагины без переписывания ядра,
- локальный приоритет (local-first) с опциональными облачными провайдерами.

Текущий стабильный runtime:

- `python server/main.py` — ядро: API, дашборд, один агент, resident-плагины (например Discord при включённом конфиге),
- `python server/main.py --mode console` — только консоль для экспериментов с промптами,
- интерфейс `discord` (текст + музыка) и др. — плагины в `server/modules/`,
- опциональный **Docker** через `server/Dockerfile` + `server/docker-compose.yml`.

### Дашборд (frontend)

Веб-интерфейс: **React + Vite + Tailwind CSS** в каталоге `server/dashboard/`. Сборка — `server/dashboard/dist`, раздаётся Internal API (`npm install && npm run build` перед продакшеном).

### MCP debug (IDE)

Опциональный **Model Context Protocol** debug-сервер в `devtools/mcp_server/` (stdio MCP для Cursor): хвост логов, вызовы `/v1`, инъекция событий в шину (`POST /v1/debug/fire_event`), снимок памяти (`GET /v1/debug/memory`). Настройка: `docs/ru/setup/mcp-debug-server.md`.

### Discord и музыка

Один resident-плагин `**server/modules/discord/`** (текст + музыка). Воспроизведение через **Lavalink 4.x** и актуальные **YouTube/source-плагины**; в конфиге Lavalink часто задают клиент вроде **ANDROID_VR**, если провайдер режет доступ.

### Модели — четыре роли, вложенный конфиг

Всё задаётся в `config.yaml` во вложенных блоках `openrouter.talk_model`, `brain_model`, `memory_model`, `vision_model`:

- **talk** — финальный ответ пользователю (стрим, без инструментов),
- **brain** — супервизор с `bind_tools` (MCP-aware tool-loop),
- **memory** — рефлексия, анализ дневника, сжатие LTM,
- **vision** — VL-описание изображений (единая модель через `openrouter.vision_model`).

Типичный стек — мощные **MoE** для диалога/анализа (класс **Qwen3 235B** через OpenRouter) для talk/brain, отдельные модели для memory. Старые плоские ключи (`openrouter.model`, `reflection_model`) поддерживаются с предупреждениями.

## Архитектура (кратко)

- `core/` — модель, память (STM/LTM/PeopleDB/Diary), рефлексия, инструменты, загрузка секретов.
  - `core/mcp_client.py` — **MCP-клиент** (stdio + SSE, динамические инструменты LangChain).
  - `core/ltm_maintenance.py` — жизненный цикл LTM: TTL prune, сжатие → cold archive.
  - `core/voice/` — voice-адаптеры и будущие фабрики STT/TTS.
- `server/dashboard/` — исходники React+Vite+Tailwind; продакшен-сборка в `server/dashboard/dist`.
- `server/modules/` — плагины (`plugin.yaml` + `main.py` + опционально `config.yaml`): `**discord`** (единый текст+музыка), internal API, local voice, screen и шаблон `000EXAMPLE`.
- `devtools/mcp_server/` — **MCP debug-сервер** (stdio MCP для Cursor): логи, API, fire_event, снимок памяти.
- **Документация Plugin SDK** — [HELP-RU.md](server/modules/000EXAMPLE/HELP-RU.md) (русский туториал), [HELP.md](server/modules/000EXAMPLE/HELP.md) (English).
- `scripts/` — эксплуатационные скрипты (healthcheck и вспомогательные утилиты, `inject_memes_2026.py`).
- `main.py` — точка входа (`core` или `console`).
- `run_neyra.bat` — меню на Windows.
- `run_neyra.sh` — меню на Linux/macOS (статус, остановка, git).
- `server/Dockerfile` + `server/docker-compose.yml` — контейнерный деплой (порт `8787`, тома под `server/`).

## Продуктовый вектор

Neyra развивается как персональный публичный ассистент:

- desktop-приложение ассистента с управлением ОС (через безопасные политики),
- mobile-lite клиент (чат/уведомления через API),
- микро-сайт с дашбордом, статусами и документацией API,
- внешние хранилища (в первую очередь Google Drive) для backup/restore,
- модульное расширение (voice/screen/music/plugins),
- **MCP-native интеграции** — внешние возможности через стандартные MCP-серверы,
- **vision pipeline** — понимание экрана через VL-модели (caption → brain tool-loop → ответ talk).

Форм-фактор "ИИ-станции" оставлен в future backlog и не входит в текущую реализацию.

## Быстрый старт

### Python (напрямую)

1. Создай и активируй venv:
  - `python -m venv .venv`
  - Windows: `.venv\Scripts\activate`
  - Linux/macOS: `source .venv/bin/activate`
2. Установи зависимости:
  - `pip install -r server/requirements.txt`
3. Создай `server/.env` из `server/.env.example` и заполни секреты.
4. Создай `server/config.yaml` из `server/config.example.yaml` и настрой:
  - укажи вложенные блоки `openrouter.talk_model.model`, `brain_model.model`, `memory_model.model`, `vision_model.model`.
5. Скопируй шаблоны конфигов плагинов:
  - `server/modules/discord/config.example.yaml` → `server/modules/discord/config.yaml`
  - `server/modules/internal_api/config.example.yaml` → `server/modules/internal_api/config.yaml`
  - при необходимости другие: `server/modules/<id>/config.example.yaml` → `server/modules/<id>/config.yaml`
6. Preflight (пример): `python scripts/healthcheck.py --mode console --skip-http`
7. Запуск:
  - Windows: `run_neyra.bat`
  - Linux/macOS: `chmod +x run_neyra.sh && ./run_neyra.sh`
  - Напрямую: `python server/main.py` (ядро) или `python server/main.py --mode console`

### Docker (опционально)

```bash
docker compose -f server/docker-compose.yml up --build
```

Порт `8787`; runtime под `server/` (`config.yaml`, `modules/`, `data/memory/`, `logs/`).

## Режимы CLI

- `core` (по умолчанию) — HTTP, дашборд, resident-плагины.
- `console` — только консоль.

Отдельных `--mode discord` и т.п. больше нет: плагины поднимаются вместе с ядром по конфигу.

## 💖 Поддержать проект

Если вам нравится проект и вы хотите поддержать его развитие (или просто скинуть автору на кофе), вы можете сделать это через криптовалюту. Адреса совпадают с кошельками в Trust Wallet и TG Wallet.

- **TON (сеть: TON):** `UQD6p87_YQNeZmGduBHnkWBF3AbvyNOwt_xt8fn1Vd3zBSYa`
- **USDT (сеть: TON):** `UQD6p87_YQNeZmGduBHnkWBF3AbvyNOwt_xt8fn1Vd3zBSYa`
- **USDT (сеть: TRC20):** `TU467q2tsQLH58u6KVh3LyGwx7sqn2WyPQ`
- **USDT (сеть: ERC20):** `0xf834f04668b947eeb56b433c54173f311a06392a`
- **ETH (Ethereum Mainnet):** `0xf834f04668b947eeb56b433c54173f311a06392a`
- **BTC (Bitcoin Network):** `bc1qevu7yty2l4u3n54gjkvj9nrtypj303ejd7e0z3`

*Обязательно проверяйте сеть при отправке! Спасибо за вашу поддержку 🚀*

Ядро остаётся open-source под лицензией MIT независимо от донатов.

## О роли ИИ в проекте (AI-assisted development)

Этот проект — практическое исследование в области **prompt engineering** и взаимодействия со сложными ИИ-системами в реальном коде.

- **Архитектура, системный дизайн и интеграция модулей** спроектированы и направляются человеком.
- **Рутинный код, обвязка и значительная часть реализации** выполнялись с активным использованием AI-агентов (Cursor, LLM-ассистенты).

Я считаю, что будущее разработки — это синергия человека-архитектора и ИИ-реализации. Если вы найдёте неоптимальные или шероховатые сгенерированные участки — открывайте Issue или PR: код-ревью от живых разработчиков только приветствуется.

## Файлы планирования и документации

- `README.md` — публичный обзор (EN).
- `README-RU.md` — публичный обзор (RU).
- `PLAN.md` — дорожная карта: закрыты Hub/core + точечные улучшения агента/голоса; активный фокус — Web UI WS-мост, затем автономный сервер/колонка.
- `docs/en/README.md` / `docs/ru/README.md` — индекс документации (архитектура, настройка, API, эксплуатация, плагины, MCP, Web UI).
- **Как писать плагины** — [HELP-RU.md](server/modules/000EXAMPLE/HELP-RU.md), [HELP.md](server/modules/000EXAMPLE/HELP.md).

