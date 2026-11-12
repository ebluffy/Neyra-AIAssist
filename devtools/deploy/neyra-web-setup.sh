#!/usr/bin/env bash
# Разовая настройка площадки сайта Neyra: /opt/neyra/web.
# Делает всё, что требует root: каталоги, Node 22, Postgres в контейнере, секреты,
# systemd-юнит neyra-web.service. Повторный запуск безопасен: существующие секреты
# и данные Postgres не перезаписываются.
#
# После этого скрипта выкладка сайта не требует root (каталог принадлежит openbot),
# кроме перезапуска юнита: systemctl restart neyra-web.
set -euo pipefail

WEB=/opt/neyra/web
NODE_SRC=/tmp/opencode/node-v22.23.4-linux-x64
COMPOSE="docker compose"  # плагин v2; /usr/bin/docker-compose здесь старый 1.29
UNIT=/etc/systemd/system/neyra-web.service

echo "== 1/6 каталоги"
mkdir -p "$WEB/app" "$WEB/data/pg"

echo "== 2/6 Node 22 рядом с сайтом (системный здесь 18)"
if [ ! -x "$WEB/node/bin/node" ]; then
  cp -a "$NODE_SRC" "$WEB/node"
fi
"$WEB/node/bin/node" -v

echo "== 3/6 секреты (только если ещё нет)"
if [ ! -f "$WEB/.env" ]; then
  DB_PASS=$(openssl rand -hex 24)
  AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  cat > "$WEB/.env" <<EOF
DATABASE_URL=postgres://neyra:${DB_PASS}@127.0.0.1:5432/neyra_web
POSTGRES_USER=neyra
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=neyra_web
BETTER_AUTH_SECRET=${AUTH_SECRET}
BETTER_AUTH_URL=http://127.0.0.1:3000
PORT=3000
NODE_ENV=production
EOF
  chmod 600 "$WEB/.env"
  echo "создан $WEB/.env (значения не печатаются)"
else
  echo "$WEB/.env уже есть — не трогаю"
fi

echo "== 4/6 Postgres 16 в контейнере, только на 127.0.0.1"
if [ ! -f "$WEB/docker-compose.yml" ]; then
  cat > "$WEB/docker-compose.yml" <<'EOF'
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    env_file: .env
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - ./data/pg:/var/lib/postgresql/data
EOF
fi
(cd "$WEB" && $COMPOSE --env-file .env up -d)
for i in $(seq 1 30); do
  if (cd "$WEB" && $COMPOSE --env-file .env exec -T db pg_isready -U neyra -d neyra_web >/dev/null 2>&1); then
    echo "Postgres готов"
    break
  fi
  sleep 1
done

echo "== 5/7 каталоги приложения принадлежат openbot (выкладка без root)"
# data/pg НЕ трогаем: это bind-mount PGDATA, у него должен остаться владелец контейнера.
mkdir -p "$WEB/data/pg"
chown openbot:openbot "$WEB" "$WEB/.env" "$WEB/docker-compose.yml" 2>/dev/null || true
chown -R openbot:openbot "$WEB/app" "$WEB/node"

echo "== 6/7 systemd-юнит neyra-web.service"
cat > "$UNIT" <<EOF
[Unit]
Description=Neyra web v2
After=network.target docker.service

[Service]
Type=simple
User=openbot
WorkingDirectory=$WEB/app/web
EnvironmentFile=$WEB/.env
Environment=PORT=3000
ExecStart=$WEB/node/bin/node server.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable neyra-web.service >/dev/null

if [ -f "$WEB/app/web/server.js" ]; then
  systemctl restart neyra-web.service
  sleep 3
  systemctl is-active neyra-web.service
  curl -fsS http://127.0.0.1:3000/api/health || echo "health сайта пока не отвечает"
else
  echo "приложение ещё не выложено ($WEB/app/web/server.js нет) — юнит установлен, но не запущен"
fi

echo "== 7/7 узкое правило sudoers на рестарт только этого юнита"
cat > /etc/sudoers.d/neyra-web-deploy <<'EOF'
# Выкладка сайта Neyra без рута: только рестарт/статус юнита сайта.
openbot ALL=(root) NOPASSWD: /bin/systemctl restart neyra-web.service, /bin/systemctl is-active neyra-web.service, /bin/systemctl status neyra-web.service
EOF
chmod 440 /etc/sudoers.d/neyra-web-deploy
visudo -c >/dev/null && echo "sudoers ok"

echo
echo "Готово. Дальше выкладка: bash /tmp/opencode/deploy-web.sh (root больше не нужен)"
