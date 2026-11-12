# Клиентский монорепо Neyra (P0)
`packages/contracts` — zod-контракты без DOM.
`packages/ui` — DOM-only React-примитивы и токены.
`apps/web` — Next.js 15 App Router, заглушка входа и health.
`apps/desktop` — Vite React shell без Tauri.
`client/` и `server/` — существующие приложения, без изменений.
Нужен Node.js 22; установка: `npm ci` в корне.
Сборка обоих приложений: `npm run build`.
Проверки: `npm test`, `npm run typecheck`, `npx tsc --build`.
P1: Better Auth, Drizzle и PostgreSQL; в P0 их нет.
