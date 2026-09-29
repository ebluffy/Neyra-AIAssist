<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Web UI (дашборд на React)

Дашборд — SPA на **React + Vite + Tailwind CSS**, раздаётся тем же процессом FastAPI, что и ядро (`python server/main.py`). Исходники — `server/dashboard/src/`, сборка — `server/dashboard/dist`.

Полное real-time совпадение с Event Bus для всех действий UI запланировано на **этап 1** (двусторонний WebSocket-мост — см. `PLAN.md`; сейчас отложен до после soak). Сейчас панель в основном использует HTTP `/v1`.

## Разделы UI

- **Home** — лендинг и обзор возможностей.
- **Dashboard** — health, память, баланс, список плагинов.
- **Plugins** — состояние плагинов, правка plugin config, invoke / reload / restart.
- **Settings** — Bearer token и обновление allow-list рантайма.
- **Webhooks** — исходящие маршруты, тесты, deliveries / DLQ.
- **API Docs** — Swagger / ReDoc и `openapi.json`.

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

Сборка попадает в `server/dashboard/dist` и раздаётся из Internal API.