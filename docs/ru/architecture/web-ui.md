# Web UI (дашборд на React)

Дашборд — SPA на **React + Vite + Tailwind CSS**, раздаётся тем же процессом FastAPI, что и ядро (из корня репо: `python server/main.py`, или из `server/` cwd: `python main.py`). Исходники — `server/dashboard/src/`, сборка — `server/dashboard/dist`.

HTTP-стек живёт в **`server/core/api/`** (Control API), это не модуль-плагин. Bind, публичный URL и поведение дашборда — в **`server/config/server.yaml`** (`api:`, `dashboard:`).

**Роль:** главная рабочая среда Neyra (статус, модули, память, система, вебхуки, настройки, документация) — локально и удалённо (VPS / публичный домен). Также полигон переносимых экранов для Tauri-клиента (Этап 3): `api/`, `components/ui/`, `screens/`, `styles/`. Web-only: `shell/` (AuthGate + sessionStorage). Чата в веб-UI нет. UI сейчас на русском; двуязычность — позже.

Полное real-time совпадение с Event Bus для всех действий UI — в backlog. Сейчас SPA в основном использует HTTP `/v1`.

## Gate по ключу доступа

Перед любой страницей дашборда SPA проверяет **ключ доступа**:

1. **Первый визит** (ключ ещё не задан): создайте ключ (минимум **32** символа; удобный вариант — «Сгенерировать hex (32)»). На сервере хранится хеш **PBKDF2** в `server/data/dashboard_auth.sqlite`.
2. **Повторные визиты:** вход тем же ключом. После login SPA держит **session token** в **`sessionStorage`** (хеши сессий также в SQLite — переживают рестарт процесса).
3. **`POST /v1/dashboard/auth/setup`** разрешён только пока ключ не задан. Без Bearer — только с консольного loopback (нет CF/X-Real); с публичного края — primary `API_TOKEN`.
4. Login/setup выдаёт **`session_token`**; SPA шлёт его как Bearer (admin). Сырой ключ **не** принимается как Bearer. Logout отзывает session.
5. Если session истекла или отозвана, любой `/v1/*` с **401** очищает session и возвращает на экран входа (без «залипших» ошибок на экранах).

## Разделы UI

| Nav | Route | Назначение |
|-----|-------|------------|
| Статус | `/status` | health, models, balance, soft-restart (`/dashboard` → redirect) |
| Модули | `/modules` | list/toggle/config/invoke/reload/restart (`/plugins` → redirect; API всё ещё `/v1/plugins`) |
| Память | `/memory` | stats, people, diary, search, LTM |
| Система | `/system` | meta, backup, DLQ summary |
| Вебхуки | `/webhooks` | routes, deliveries, DLQ |
| Настройки | `/settings` | Bearer override + `GET/POST` runtime config (allowlist) |
| API Docs | `/api-docs` | Swagger / ReDoc / Markdown |

## Runtime config

- `GET /v1/config/runtime` — снимок allowlisted ключей (без секретов `.env`).
- `POST /v1/config/update` — запись тех же ключей.

## Разработка

```bash
cd server/dashboard
npm install
npm run dev
```

Proxy на backend — в `vite.config.ts`.

## Сборка

```bash
cd server/dashboard
npm install
npm run build
```

Сборка → `server/dashboard/dist`, раздаётся Control API.
