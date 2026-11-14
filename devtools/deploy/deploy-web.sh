#!/usr/bin/env bash
# Сборка, миграции и выкладка сайта Neyra. Root не нужен:
# перезапуск юнита и дамп базы разрешены узкими правилами sudoers из neyra-web-setup.sh.
#
# Использование: bash devtools/deploy/deploy-web.sh [путь к web]
# По умолчанию берётся web/ из checkout'а, в котором лежит этот скрипт.
set -euo pipefail

DEFAULT_SRC="$(cd "$(dirname "$0")/../../web" && pwd)"
SRC="${1:-$DEFAULT_SRC}"
DST=/opt/neyra/web/app
ENV_FILE=/opt/neyra/web/.env
NODE_BIN=/opt/neyra/web/node/bin

if [ ! -x "$NODE_BIN/node" ]; then
  echo "Нет Node 22 в $NODE_BIN — сначала выполни: sudo bash devtools/deploy/neyra-web-setup.sh https://example.test"
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Нет $ENV_FILE — сначала выполни: sudo bash devtools/deploy/neyra-web-setup.sh https://example.test"
  exit 1
fi

export PATH="$NODE_BIN:$PATH"

echo "== переменные окружения площадки"
ENV_LOADER="$(dirname "$0")/env-load.py"
[ -f "$ENV_LOADER" ] || { echo "нет env-load.py рядом со скриптом" >&2; exit 1; }
TMP_ENV=$(mktemp)
trap 'rm -f "$TMP_ENV"' EXIT
if ! python3 "$ENV_LOADER" "$ENV_FILE" > "$TMP_ENV"; then
  echo "не удалось разобрать $ENV_FILE" >&2
  exit 1
fi
while IFS= read -r -d '' kv; do export "$kv"; done < "$TMP_ENV"
for v in NEYRA_WS_URL NEYRA_SERVICE_KEY NEYRA_IDENTITY_JWT_SECRET NEYRA_IDENTITY_JWT_ISSUER; do
  if [ -z "${!v:-}" ]; then echo "внимание: $v пуст — чат сайта вернёт 503" >&2; fi
done

ROOT="$(dirname "$SRC")"   # корень монорепо: здесь npm workspaces
# Собираем в чистой копии: без локальных node_modules/.next и незакоммиченных артефактов.
BUILD_DIR="${BUILD_DIR:-$(mktemp -d /tmp/neyra-web-build.XXXXXX)}"
trap 'rm -rf "$BUILD_DIR" "$TMP_ENV"' EXIT
if [ "$(realpath "$ROOT")" != "$(realpath -m "$BUILD_DIR")" ]; then
  echo "== чистая копия исходников в $BUILD_DIR"
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"
  rsync -a --exclude node_modules --exclude .next --exclude .git "$ROOT"/ "$BUILD_DIR"/
  SRC="$BUILD_DIR/${SRC#"$ROOT"/}"
  ROOT="$BUILD_DIR"
fi
echo "== сборка из $ROOT"
cd "$ROOT"
npm ci --include=dev --no-audit --no-fund
npm run build

cd "$SRC"                  # web/
STAGE=.next/standalone
[ -f "$STAGE/web/server.js" ] || { echo "Нет $STAGE/web/server.js — проверь output: 'standalone'"; exit 1; }

echo "== резервная копия базы перед миграциями"
BACKUP_DIR=/opt/neyra/web/backups
mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/pre-migrate-$(date +%Y%m%d-%H%M%S).dump"
# pg_dump только из контейнера (клиента на хосте нет); вывод — на хост в $DUMP.
if ! sudo -n docker compose -f /opt/neyra/web/docker-compose.yml exec -T postgres pg_dump -U neyra -d neyra_web -Fc > "$DUMP" 2>/dev/null; then
  echo "pg_dump не выполнился — миграции отменены, база не тронута" >&2
  rm -f "$DUMP"
  exit 1
fi
if [ ! -s "$DUMP" ]; then
  echo "дамп пуст — миграции отменены, база не тронута" >&2
  rm -f "$DUMP"
  exit 1
fi
ls -1t "$BACKUP_DIR"/pre-migrate-*.dump | tail -n +11 | xargs -r rm -f
echo "дамп: $DUMP"

echo "== миграции базы сайта"
npx drizzle-kit migrate

echo "== выкладка в $DST"
# Копируем всё дерево standalone: рядом с web/ лежат node_modules (next, pg).
rsync -a --delete .next/standalone/ "$DST"/
APP="$DST/web"
mkdir -p "$APP/.next"
rsync -a --delete .next/static/ "$APP/.next/static/"
if [ -d public ]; then rsync -a --delete public/ "$APP/public/"; fi
if [ -d scripts ]; then rsync -a --delete scripts/ "$APP/scripts/"; fi
if ! (cd "$DST" && "$NODE_BIN/node" -e "require.resolve('next'); require.resolve('pg')"); then echo "в standalone нет next/pg — проверь сборку"; exit 1; fi

echo "== перезапуск сайта"
sudo -n systemctl restart neyra-web.service
sleep 3
systemctl is-active neyra-web.service
curl -fsS http://127.0.0.1:3000/api/health && echo
