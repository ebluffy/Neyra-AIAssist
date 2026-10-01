<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Web UI (дашборд на React)

Дашборд — SPA на **React + Vite + Tailwind CSS**, раздаётся тем же процессом FastAPI, что и ядро (из корня репо: `python server/main.py`, или из `server/` cwd: `python main.py`). Исходники — `server/dashboard/src/`, сборка — `server/dashboard/dist`.

HTTP-стек живёт в **`server/core/api/`** (Control API), это не модуль-плагин. Bind, публичный URL и поведение дашборда — в **`server/config/server.yaml`** (`api:`, `dashboard:`).

Полное real-time совпадение с Event Bus для всех действий UI — в backlog (двусторонний WebSocket-мост — см. [`docs/PLAN.md`](../../PLAN.md)). Сейчас SPA в основном использует HTTP `/v1`.

## Gate по ключу доступа

Перед любой страницей дашборда SPA проверяет **ключ доступа**:

1. **Первый визит** (ключ ещё не задан): создайте ключ (минимум **8** символов; удобный вариант — случайная строка **hex-32**). На сервере хранится хеш **PBKDF2** в `server/data/dashboard_auth.sqlite`.
2. **Повторные визиты:** вход тем же ключом. Plaintext ключ держится в **`sessionStorage`** до «Выйти».
3. **`POST /v1/dashboard/auth/setup`** разрешён только пока ключ не задан. Если bind API **не** loopback, setup принимается **только с loopback-клиента** (защита от удалённой гонки за ключ).
4. **`POST /v1/dashboard/auth/login`** и **`GET /v1/dashboard/auth/status`** публичны. После успешного login/setup API отдаёт короткоживущий **`session_token`**; SPA кладёт его в **`sessionStorage`** и шлёт как **`Authorization: Bearer`**. `_resolve_role` принимает проверенную сессию (быстрый hash) как **admin**. Сырой ключ дашборда **не** принимается как Bearer (без PBKDF2 на каждый poll). Отдельные `API_TOKEN` / viewer / maint — для Discord, MCP, скриптов и Settings.

Этот gate **отделён** от Tauri-клиента Этапа 3 (`client/`): десктопное приложение ходит в тот же Control API с URL сервера и API-токеном, а не через flow ключа дашборда.

## Разделы UI

- **Home** — лендинг и обзор возможностей.
- **Dashboard** — health, память, баланс, список плагинов.
- **Plugins** — состояние плагинов, правка plugin config, invoke / reload / restart.
- **Settings** — Bearer token и обновление allow-list рантайма.
- **Webhooks** — исходящие маршруты, тесты, deliveries / DLQ.
- **API Docs** — Swagger / ReDoc и `openapi.json`.

(Вкладки «Микро-сайт» нет; публичные маркетинговые страницы вне scope этой SPA.)

## Разработка

```bash
cd server/dashboard
npm install
npm run dev
```

Proxy на backend настраивается в `vite.config.ts` (`/v1`, `/docs`, `/redoc`, `/openapi.json`).

## Сборка

```bash
cd server/dashboard
npm run build
```

Сборка попадает в `server/dashboard/dist` и раздаётся статическим mount Control API.
