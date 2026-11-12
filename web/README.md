# Сайт — P1: аккаунты
Next.js 15 App Router, Better Auth, PostgreSQL 16, Drizzle. Ядро не вызывается.
`/login`, `/signup` — email/пароль (10–128 символов), `/` — сессия и выход; `/api/health` не зависит от БД.
Роль в PostgreSQL enum `admin | user`, default `user`. Входные данные регистрации роль не задают (`input: false`); пароль хранит Better Auth в account как хеш.

## Настройка при деплое
1. Передать DATABASE_URL (postgresql URL), BETTER_AUTH_SECRET (случайный секрет минимум 32 символа) и BETTER_AUTH_URL (origin сайта) через окружение. Образец пустой, настоящие значения не коммитить.
2. Если используется compose: отдельно задать POSTGRES_PASSWORD и тот же пароль в DATABASE_URL; `docker compose -f web/docker-compose.yml up -d`. Порт только 127.0.0.1:5432, данные в ignored web/data/pg.
3. Из корня: `npm ci`, `npm run db:migrate -w @neyra/web` с DATABASE_URL в окружении, затем `npm run build`. Миграции — до обслуживания трафика; при существующей БД сначала проверить SQL и резервную копию.
4. Запуск — standalone-сборка: `npm run build` кладёт её в `web/.next/standalone/web/`. Разложить на площадке: `standalone/web/` → `/opt/neyra/web/app/`, `web/.next/static/` → `/opt/neyra/web/app/.next/static/`, `web/public/` → `/opt/neyra/web/app/public/`, затем `node server.js` из каталога приложения (`next start` с `output: 'standalone'` не используется).
5. При изменении схемы: `npm run db:generate -w @neyra/web`; генерация SQL не требует DATABASE_URL или живой БД.

Сборка без env и соединения с БД: auth, pool и env инициализируются только при запросе; главная страница динамическая. Без runtime env вход не работает. Не логировать конфигурацию с секретами.
Email не подтверждается, почта не отправляется. Регистрация в этом срезе открыта, каждый новый аккаунт — `user`. Администратор **не** выдаётся при регистрации (адрес почты не доказывает владение): после того как человек зарегистрировался, роль выдаётся с сервера командой `npm run admin:grant -w @neyra/web -- user@example.com` (снять — `--revoke`). Approval/invite, админка, OAuth, восстановление пароля и остальные режимы регистрации — следующие задачи. Не заявляется полный паритет со всей спецификацией web-v2.
Сессии 30 дней; CSRF/origin, cookie и хеширование — Better Auth. Для настоящего деплоя нужен HTTPS и корректный публичный origin/reverse proxy.
