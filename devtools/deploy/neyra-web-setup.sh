#!/usr/bin/env bash
# Разовая настройка площадки сайта Neyra: /opt/neyra/web.
# Делает всё, что требует root: каталоги, Node 22, Postgres в контейнере, секреты,
# systemd-юнит neyra-web.service. Повторный запуск безопасен: существующие секреты
# и данные Postgres не перезаписываются, BETTER_AUTH_URL обновляется до аргумента.
#
# Использование: sudo bash devtools/deploy/neyra-web-setup.sh https://example.test
#   (публичный HTTPS-origin сайта; можно задать через PUBLIC_URL вместо аргумента)
#
# После этого скрипта выкладка сайта не требует root (каталог принадлежит openbot),
# кроме перезапуска юнита: systemctl restart neyra-web.
set -euo pipefail

WEB=/opt/neyra/web
COMPOSE="docker compose"  # плагин v2; /usr/bin/docker-compose здесь старый 1.29
PG_SERVICE=postgres  # имя сервиса в web/docker-compose.yml
UNIT=/etc/systemd/system/neyra-web.service

# Публичный origin сайта: аргумент или PUBLIC_URL. Без него cookie и origin-проверки
# Better Auth будут неправильными, поэтому дальше не идём.
PUBLIC_URL="${1:-${PUBLIC_URL:-}}"
case "$PUBLIC_URL" in
  https://*) ;;
  *) echo "нужен публичный HTTPS-origin сайта: sudo bash devtools/deploy/neyra-web-setup.sh https://example.test" >&2; exit 2 ;;
esac
# origin без trailing slash и без пути: BETTER_AUTH_URL должен быть ровно origin.
PUBLIC_URL="${PUBLIC_URL%/}"
case "$PUBLIC_URL" in
  https://*/*) echo "PUBLIC_URL должен быть origin без пути: https://example.test" >&2; exit 2 ;;
esac

# Node: качаем с nodejs.org, сверяем SHA256. Локальный tarball можно подсунуть
# через NODE_TARBALL (проверка хэша всё равно обязательна).
NODE_VERSION=v22.23.4
NODE_DIST="node-$NODE_VERSION-linux-x64"
NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce

# Единый источник compose — файл из репозитория (web/docker-compose.yml).
# По умолчанию берём его из checkout'а, в котором лежит этот скрипт.
REPO_WEB="$(cd "$(dirname "$0")/../../web" && pwd)"
[ -f "$REPO_WEB/docker-compose.yml" ] || { echo "не найден $REPO_WEB/docker-compose.yml" >&2; exit 1; }

# Связка .env сайта с ядром — только скрипт рядом, никаких путей из /tmp.
ENV_SYNC="$(dirname "$0")/neyra-web-env.py"
[ -f "$ENV_SYNC" ] || { echo "не найден $ENV_SYNC" >&2; exit 1; }

echo "== 1/9 каталоги"
mkdir -p "$WEB/app" "$WEB/data/pg" "$WEB/backups"

echo "== 2/9 Node $NODE_VERSION рядом с сайтом (системный здесь 18)"
if [ ! -x "$WEB/node/bin/node" ]; then
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
  tarball="$tmpdir/$NODE_DIST.tar.xz"
  if [ -n "${NODE_TARBALL:-}" ]; then
    cp "$NODE_TARBALL" "$tarball"
  else
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.xz" -o "$tarball"
  fi
  echo "$NODE_SHA256  $tarball" | sha256sum -c -
  tar -xJf "$tarball" -C "$tmpdir"
  cp -a "$tmpdir/$NODE_DIST" "$WEB/node"
  rm -rf "$tmpdir"; trap - EXIT
fi
"$WEB/node/bin/node" -v

echo "== 3/9 .env секреты (только если ещё нет) и BETTER_AUTH_URL=$PUBLIC_URL"
if [ ! -f "$WEB/.env" ]; then
  DB_PASS=$(openssl rand -hex 24)
  AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  cat > "$WEB/.env" <<EOF
DATABASE_URL=postgres://neyra:${DB_PASS}@127.0.0.1:5432/neyra_web
POSTGRES_USER=neyra
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=neyra_web
BETTER_AUTH_SECRET=${AUTH_SECRET}
BETTER_AUTH_URL=${PUBLIC_URL}
PORT=3000
NODE_ENV=production
EOF
  chmod 600 "$WEB/.env"
  echo "создан $WEB/.env (значения не печатаются)"
else
  echo "$WEB/.env уже есть — секреты не трогаю, BETTER_AUTH_URL привожу к $PUBLIC_URL"
  python3 - "$WEB/.env" "$PUBLIC_URL" <<'PY'
import os, sys, tempfile
path, url = sys.argv[1], sys.argv[2]
lines = open(path, encoding='utf-8').read().splitlines()
out = [line for line in lines if not line.startswith('BETTER_AUTH_URL=')]
out.append(f'BETTER_AUTH_URL={url}')
fd, tmp = tempfile.mkstemp(prefix='.env.', dir=os.path.dirname(path))
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(out) + '\n')
        handle.flush(); os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    st = os.stat(path)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, path)
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
PY
fi

echo "== 4/9 связка с ядром: NEYRA_* в .env сайта"
python3 "$ENV_SYNC"

echo "== 5/9 Postgres 16 в контейнере (compose из репозитория), только на 127.0.0.1"
install -o root -g root -m 644 "$REPO_WEB/docker-compose.yml" "$WEB/docker-compose.yml"
(cd "$WEB" && $COMPOSE up -d --wait)
for i in $(seq 1 10); do
  if (cd "$WEB" && $COMPOSE exec -T $PG_SERVICE pg_isready -U neyra -d neyra_web >/dev/null 2>&1); then
    echo "Postgres готов"
    break
  fi
  sleep 1
  if [ "$i" = 10 ]; then
    echo "Postgres не поднялся за отведённое время — см. docker compose logs в $WEB" >&2
    exit 1
  fi
done

echo "== 6/9 каталоги приложения принадлежат openbot (выкладка без root)"
# data/pg НЕ трогаем: это bind-mount PGDATA, у него должен остаться владелец контейнера.
mkdir -p "$WEB/data/pg"
chown openbot:openbot "$WEB" "$WEB/.env" "$WEB/docker-compose.yml" 2>/dev/null || true
chown -R openbot:openbot "$WEB/app" "$WEB/node" "$WEB/backups"

echo "== 7/9 systemd-юнит neyra-web.service"
cat > "$UNIT" <<EOF
[Unit]
Description=Neyra web v2
After=network.target docker.service

[Service]
Type=simple
User=openbot
WorkingDirectory=$WEB/app/web
EnvironmentFile=$WEB/.env
Environment=HOSTNAME=127.0.0.1
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

echo "== 8/9 узкое правило sudoers: рестарт юнита и дамп базы перед миграциями"
sudoers_tmp=$(mktemp)
cat > "$sudoers_tmp" <<'EOF'
# Выкладка сайта Neyra без рута: только рестарт/статус юнита сайта
# и pg_dump базы сайта перед миграциями (deploy-web.sh, AR-14).
openbot ALL=(root) NOPASSWD: /bin/systemctl restart neyra-web.service, /bin/systemctl is-active neyra-web.service, /bin/systemctl status neyra-web.service
openbot ALL=(root) NOPASSWD: /usr/bin/docker compose -f /opt/neyra/web/docker-compose.yml exec -T $PG_SERVICE pg_dump -U neyra -d neyra_web -Fc
EOF
chmod 440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null
install -m 440 "$sudoers_tmp" /etc/sudoers.d/neyra-web-deploy
rm -f "$sudoers_tmp"
echo "sudoers ok"

echo "== 9/9 готово"
echo "Выкладка сайта (root больше не нужен): bash devtools/deploy/deploy-web.sh"
