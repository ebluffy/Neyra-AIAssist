# Сайт — P1: аккаунты
Next.js 15 App Router, Better Auth, PostgreSQL 16, Drizzle. Ядро не вызывается.
`/login`, `/signup` — email/пароль (10–128 символов), `/` — сессия и выход; `/api/health` не зависит от БД.
Роль в PostgreSQL enum `admin | user`, default `user`. Входные данные регистрации роль не задают (`input: false`); пароль хранит Better Auth в account как хеш.

## Настройка при деплое
1. Передать DATABASE_URL (postgresql URL), BETTER_AUTH_SECRET (случайный секрет минимум 32 символа) и BETTER_AUTH_URL (origin сайта) через окружение. Образец пустой, настоящие значения не коммитить.
   Для чата нужны NEYRA_WS_URL, NEYRA_SERVICE_KEY (admin Bearer ядра) и пара NEYRA_IDENTITY_JWT_SECRET + NEYRA_IDENTITY_JWT_ISSUER — оба identity-параметра обязательны и должны совпадать у ядра и сайта (ядро #73 требует issuer без дефолта; сайт подписывает `iss` ровно им, при расхождении подпись отклоняется). `devtools/deploy/neyra-web-env.py` заполняет их идемпотентно: issuer по умолчанию `neyra-web`, уже заданное непустое значение не перезаписывается, расхождение сайта с ядром приводится к ядру с предупреждением; новый секрет ядро принимает только после перезапуска `neyra.service`.
2. Если используется compose: отдельно задать POSTGRES_PASSWORD и тот же пароль в DATABASE_URL; `docker compose -f web/docker-compose.yml up -d`. Порт только 127.0.0.1:5432, данные в ignored web/data/pg.
3. Из корня: `npm ci`, `npm run db:migrate -w @neyra/web` с DATABASE_URL в окружении, затем `npm run build`. Миграции — до обслуживания трафика; при существующей БД сначала проверить SQL и резервную копию.
4. Запуск — standalone-сборка: `npm run build` кладёт её в `web/.next/standalone/`. Копировать надо **всё дерево целиком** (`node_modules/`, `package.json`, `web/`), иначе `server.js` не найдёт `next`: `standalone/` → `/opt/neyra/web/app/`, затем `web/.next/static/` → `/opt/neyra/web/app/web/.next/static/`, `web/public/` → `/opt/neyra/web/app/web/public/`, `web/scripts/` → `/opt/neyra/web/app/web/scripts/`. Запуск: `HOSTNAME=127.0.0.1 PORT=3000 node server.js` из `/opt/neyra/web/app/web` — без `HOSTNAME` standalone слушает `0.0.0.0` и открыт всей локальной сети в обход nginx/frp (`next start` с `output: 'standalone'` не используется).
5. При изменении схемы: `npm run db:generate -w @neyra/web`; генерация SQL не требует DATABASE_URL или живой БД.

Сборка без env и соединения с БД: auth, pool и env инициализируются только при запросе; главная страница динамическая. Без runtime env вход не работает. Не логировать конфигурацию с секретами.
Email не подтверждается, почта не отправляется. **Регистрация — только по одноразовым инвайтам** (AR-2): публичный signup на сервере отклоняется хуком Better Auth, без действующего инвайта аккаунт не создаётся. Администратор **не** выдаётся при регистрации (адрес почты не доказывает владение): после того как человек зарегистрировался, роль выдаётся с сервера командой `npm run admin:grant -w @neyra/web -- user@example.com` (снять — `--revoke`); на площадке — `cd /opt/neyra/web/app/web && node scripts/grant-admin.mjs user@example.com` при заданной `DATABASE_URL` (`pg` тянется из `/opt/neyra/web/app/node_modules`). Approval/invite-режимы поверх, админка, OAuth, восстановление пароля — следующие задачи. Не заявляется полный паритет со всей спецификацией web-v2.

## Инвайты: как выдать и как зарегистрироваться

Инвайт создаёт администратор на сервере (нужны `DATABASE_URL` и `BETTER_AUTH_URL` в окружении):

```
cd /opt/neyra/web/app/web && node scripts/invite-create.mjs            # TTL 24 ч
node scripts/invite-create.mjs --ttl-hours 48 --by admin@example.com
```

Скрипт печатает одноразовую ссылку вида `<BETTER_AUTH_URL>/signup?invite=<токен>`. В базе хранится только sha256 токена, срок действия и факт использования — сам токен нигде, кроме ссылки, не сохраняется. Ссылка одноразовая: после успешной регистрации в `used_by`/`used_at` фиксируются email и время, повторное использование или просрочка отклоняются с понятным сообщением.

Приглашённый открывает ссылку (код подставляется автоматически) или вручную вставляет код на `/signup` — там же объяснение «только по инвайту». Дальше обычная регистрация: email и пароль 10–128 символов.
Сессии 30 дней; CSRF/origin, cookie и хеширование — Better Auth. Для настоящего деплоя нужен HTTPS и корректный публичный origin/reverse proxy.
