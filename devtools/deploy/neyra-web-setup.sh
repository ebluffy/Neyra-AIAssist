#!/usr/bin/env bash
# Разовая настройка площадки сайта Neyra: /opt/neyra/web.
# Делает всё, что требует root: каталоги, Node 22, Postgres в контейнере, секреты,
# systemd-юнит neyra-web.service. Повторный запуск безопасен: существующие секреты
# и данные Postgres не перезаписываются, BETTER_AUTH_URL обновляется до аргумента.
#
# Использование: sudo bash devtools/deploy/neyra-web-setup.sh https://example.test
#   (публичный HTTPS-origin сайта; можно задать через PUBLIC_URL вместо аргумента)
#
# После этого скрипта выкладка сайта не требует root: openbot владеет только
# app/, node/ и читает .env; /opt/neyra/web, compose и db.env — root.
# Root нужен лишь на перезапуск юнита и дамп БД (узкое правило sudoers).
set -euo pipefail

WEB=/opt/neyra/web
BACKUP_DIR=/var/backups/neyra-web
PG_SERVICE=postgres  # имя сервиса в web/docker-compose.yml
COMPOSE_PROJECT=web
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
# AR-27: корневые файлы не должны лежать в каталоге, которым владеет openbot.
# $WEB, $WEB/data и $BACKUP_DIR принадлежат root; openbot — только app/, node/.
# Симлинк на месте любого из них — отказ: root иначе chown/chmod'нул бы цель ссылки.
for dir in "$WEB" "$WEB/data" "$BACKUP_DIR"; do
  [ ! -L "$dir" ] || { echo "$dir — символическая ссылка, отказ" >&2; exit 1; }
done
mkdir -p "$WEB/app" "$WEB/data/pg" "$BACKUP_DIR"
chown root:root "$WEB" "$WEB/data"
chmod 0755 "$WEB" "$WEB/data"
# Дампы: /var/backups/neyra-web, родитель /var/backups принадлежит root.
chown root:root "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
chown openbot:openbot "$WEB/app" 2>/dev/null || true

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
# AR-27: .env — корневой файл. Симлинк на его месте означал бы чтение/запись
# (и chown) чужого файла от root, поэтому отказываем, а не идём по ссылке.
[ ! -L "$WEB/.env" ] || { echo "$WEB/.env — символическая ссылка, отказ" >&2; exit 1; }
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
# db.env — только переменные compose (POSTGRES_*), root:root 0600. Compose читает
# его явно (--env-file), поэтому openbot-овый .env площадки на root не влияет.
python3 - "$WEB/.env" "$WEB/db.env" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
want = ("POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB")
values = {}
with open(src, encoding="utf-8") as handle:
    for line in handle:
        line = line.rstrip("\n")
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() in want:
            values[key.strip()] = value.strip()
missing = [key for key in want if not values.get(key)]
if missing:
    raise SystemExit(f"в {src} нет {', '.join(missing)} — не могу собрать db.env для compose")
tmp = dst + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    for key in want:
        handle.write(f"{key}={values[key]}\n")
os.chmod(tmp, 0o600)
os.chown(tmp, 0, 0)
os.replace(tmp, dst)
PY
COMPOSE_SITE=(docker compose -p "$COMPOSE_PROJECT" --env-file "$WEB/db.env" -f "$WEB/docker-compose.yml")
(cd "$WEB" && "${COMPOSE_SITE[@]}" up -d --wait)
for i in $(seq 1 10); do
  if (cd "$WEB" && "${COMPOSE_SITE[@]}" exec -T $PG_SERVICE pg_isready -U neyra -d neyra_web >/dev/null 2>&1); then
    echo "Postgres готов"
    break
  fi
  sleep 1
  if [ "$i" = 10 ]; then
    echo "Postgres не поднялся за отведённое время — см. docker compose logs в $WEB" >&2
    exit 1
  fi
done

echo "== 6/9 права: openbot пишет только app/ и node/, .env читает"
# data/pg НЕ трогаем: это bind-mount PGDATA, у него должен остаться владелец контейнера.
# $WEB, compose и db.env остаются root: openbot не может подменить описание сервисов
# или переменные compose (AR-27). .env нужен openbot на чтение env-load.py.
mkdir -p "$WEB/data/pg"
chown root:root "$WEB" "$WEB/data" "$WEB/docker-compose.yml" "$WEB/db.env"
chmod 0755 "$WEB" "$WEB/data"
chmod 0644 "$WEB/docker-compose.yml"
chmod 0600 "$WEB/db.env"
chown -R openbot:openbot "$WEB/app" "$WEB/node" 2>/dev/null || true
if [ -f "$WEB/.env" ]; then
  [ ! -L "$WEB/.env" ] || { echo "$WEB/.env — символическая ссылка, отказ" >&2; exit 1; }
  chown -h root:openbot "$WEB/.env"
  chmod 0640 "$WEB/.env"
fi

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
# Root-хелпер ставится из репозитория и остаётся единственным путём к docker:
# прямых правил `docker compose exec` от root в sudoers нет (AR-27).
install -m 0755 "$(dirname "$0")/openbot-admin" /usr/local/sbin/openbot-admin
sudoers_tmp=$(mktemp)
cat > "$sudoers_tmp" <<EOF
# Выкладка сайта Neyra без рута: только рестарт/статус юнита сайта
# и pg_dump базы сайта перед миграциями (deploy-web.sh, AR-14).
openbot ALL=(root) NOPASSWD: /bin/systemctl restart neyra-web.service, /bin/systemctl is-active neyra-web.service, /bin/systemctl status neyra-web.service
openbot ALL=(root) NOPASSWD: /usr/local/sbin/openbot-admin db-dump
EOF
chmod 440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null
install -m 440 "$sudoers_tmp" /etc/sudoers.d/neyra-web-deploy
rm -f "$sudoers_tmp"
echo "sudoers ok"

echo "== 9/9 готово"
echo "Выкладка сайта (root больше не нужен): bash devtools/deploy/deploy-web.sh"
