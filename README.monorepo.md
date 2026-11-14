# Монорепо Neyra

Корень — `server/`, `web/`, `desktop/`, `mobile/`, `docs/`, `devtools/`, `packages/` (общий код), плюс корневые файлы.

- `server/` — ядро (Python, FastAPI).
- `web/` — сайт v2 (Next.js App Router, npm-workspace).
- `desktop/` — приложение (Tauri + Vite). Пока лежит в `client/`: переименование после влития десктопного PR, чтобы не ломать его.
- `mobile/` — задел на мобильный клиент.
- `docs/` — документы, `devtools/` — служебные инструменты.
- `packages/contracts` — DTO и zod-схемы для веба, десктопа и мобильного; `packages/ui` — DOM-only примитивы и токены.

Сборка: `npm ci && npm run build`, тесты: `npm test`, типы: `npm run typecheck`.
