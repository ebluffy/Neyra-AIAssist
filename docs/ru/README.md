# Документация Neyra (русский)

**English:** [Neyra documentation (EN)](../en/README.md)

Русская документация — в `docs/ru/**`.

| Раздел | Содержание |
|--------|------------|
| [architecture/](architecture/overview.md) | Архитектура, модель конфигурации, безопасность, **Web UI** |
| [setup/](setup/quickstart.md) | Быстрый старт, переменные окружения, конфиг, **MCP debug-сервер** |
| [ops/](ops/deployment-local.md) | Деплой, мониторинг, troubleshooting, бэкапы, **WSS** |
| [api/](api/overview.md) | REST, WebSocket, OpenAPI, ошибки, примеры |
| [usage/](usage/end-user-guide.md) | Пользователям, админам, интеграция, FAQ |
| [plugins/](plugins/overview.md) | Плагины SDK, манифесты, события, cookbook |
| [development/](development/contributing.md) | Участие в проекте |
| [reference/](reference/vocard-upstream.md) | Внешние референсы (Vocard и т.д.) |

Ключевые документы по реформе клиента:

- [architecture/web-v2.md](architecture/web-v2.md) — спека веб-клиента v2: решения D1–D27, схема данных, идентичность, деплой, этапы P0–P6.
- [architecture/adr-0001-client-monorepo.md](architecture/adr-0001-client-monorepo.md) — ADR о клиентском монорепо `packages/ui` + `packages/contracts` + `apps/web` + `apps/desktop`; Rust и IPC не меняются.

**Репозиторий:** [github.com/ebluffy/Neyra-AIAssist](https://github.com/ebluffy/Neyra-AIAssist)

Файлы в корне: `README.md`, `README-RU.md`, дорожная карта — [`docs/PLAN.md`](../PLAN.md).  
Примеры плагина не переносятся: `server/modules/000EXAMPLE/`.
