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
DRY=${DRY:-0}

if [ "$DRY" = 1 ]; then
  echo "== DRY=1: проверяю сборку и цель, в /opt/neyra ничего не пишу"
  if [ -x "$NODE_BIN/node" ]; then
    export PATH="$NODE_BIN:$PATH"
  else
    echo "внимание: $NODE_BIN/node нет — использую node из PATH; env площадки не требуется" >&2
  fi
else
  if [ ! -x "$NODE_BIN/node" ]; then
    echo "Нет Node 22 в $NODE_BIN — сначала выполни: sudo bash devtools/deploy/neyra-web-setup.sh https://example.test"
    exit 1
  fi
  if [ ! -f "$ENV_FILE" ]; then
    echo "Нет $ENV_FILE — сначала выполни: sudo bash devtools/deploy/neyra-web-setup.sh https://example.test"
    exit 1
  fi
  export PATH="$NODE_BIN:$PATH"
fi

TMP_ENV=""
trap 'rm -f "$TMP_ENV"' EXIT
if [ "$DRY" != 1 ]; then
  echo "== переменные окружения площадки"
  ENV_LOADER="$(dirname "$0")/env-load.py"
  [ -f "$ENV_LOADER" ] || { echo "нет env-load.py рядом со скриптом" >&2; exit 1; }
  TMP_ENV=$(mktemp)
  if ! python3 "$ENV_LOADER" "$ENV_FILE" > "$TMP_ENV"; then
    echo "не удалось разобрать $ENV_FILE" >&2
    exit 1
  fi
  while IFS= read -r -d '' kv; do export "$kv"; done < "$TMP_ENV"
  for v in NEYRA_WS_URL NEYRA_WEB_KEY NEYRA_ADMIN_KEY NEYRA_IDENTITY_JWT_SECRET NEYRA_IDENTITY_JWT_ISSUER; do
    if [ -z "${!v:-}" ]; then echo "внимание: $v пуст — чат сайта вернёт 503" >&2; fi
  done
fi

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

if [ "$DRY" = 1 ]; then
  echo "DRY: сборка ok — $SRC/$STAGE/web/server.js"
  echo "DRY: цель выкладки $DST не тронута; бэкап базы, миграции и rsync пропущены"
  exit 0
fi

SCHEMA_MARKER="$DST/web/.schema-migrations.sha"
CURRENT_SCHEMA="$(find db/migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"

if [ "${SKIP_DB_MIGRATIONS:-0}" = "1" ]; then
  # Пропуск разрешён только когда набор миграций совпадает с уже выложенным:
  # иначе сайт стартует на старой схеме и молча теряет новые таблицы/колонки.
  DEPLOYED_SCHEMA="$(cat "$SCHEMA_MARKER" 2>/dev/null || true)"
  if [ "$CURRENT_SCHEMA" != "$DEPLOYED_SCHEMA" ]; then
    echo "ОШИБКА: SKIP_DB_MIGRATIONS=1, но в исходниках есть миграции, которых нет в выложенной схеме." >&2
    echo "  схема сейчас:   ${DEPLOYED_SCHEMA:-нет отметки в $DST/web/.schema-migrations.sha}" >&2
    echo "  схема в ветке:  $CURRENT_SCHEMA" >&2
    echo "  выкладка остановлена: примените миграции обычным запуском (без SKIP_DB_MIGRATIONS)." >&2
    echo "  ручной обход допустим только после применения SQL и записи хеша в $DST/web/.schema-migrations.sha." >&2
    exit 1
  fi
  echo "== ВНИМАНИЕ: дамп и миграции пропущены (SKIP_DB_MIGRATIONS=1)"
  echo "   набор миграций совпадает с выложенным ($CURRENT_SCHEMA)"
else

echo "== резервная копия базы перед миграциями"
# Единственный путь к docker — root-хелпер openbot-admin (AR-27): у openbot нет
# sudo-правил на `docker compose exec`, а дампы лежат в /var/backups/neyra-web
# (root:root 0700). Deploy не читает файл из закрытого каталога: хелпер печатает
# path=/size= только после успешного непустого pg_dump, код возврата — проверка.
if ! DUMP_INFO="$(sudo -n openbot-admin db-dump)"; then
  echo "pg_dump не выполнился — миграции отменены, база не тронута." >&2
  echo "  нужен root-хелпер: sudo bash devtools/deploy/neyra-web-setup.sh <origin>" >&2
  echo "  (ставит openbot-admin и правило sudoers; см. devtools/deploy/README.md)" >&2
  exit 1
fi
DUMP_PATH="$(printf '%s\n' "$DUMP_INFO" | sed -n 's/^path=//p')"
DUMP_SIZE="$(printf '%s\n' "$DUMP_INFO" | sed -n 's/^size=//p')"
if [ -z "$DUMP_PATH" ] || ! [ "${DUMP_SIZE:-0}" -gt 0 ] 2>/dev/null; then
  echo "хелпер не вернул path=/size= — миграции отменены" >&2
  exit 1
fi
echo "дамп: $DUMP_PATH ($DUMP_SIZE байт)"

echo "== миграции базы сайта"
npx drizzle-kit migrate

fi

echo "== выкладка в $DST"
# Копируем всё дерево standalone: рядом с web/ лежат node_modules (next, pg).
rsync -a --delete .next/standalone/ "$DST"/
APP="$DST/web"
mkdir -p "$APP/.next"
rsync -a --delete .next/static/ "$APP/.next/static/"
if [ -d public ]; then rsync -a --delete public/ "$APP/public/"; fi
if [ -d scripts ]; then rsync -a --delete scripts/ "$APP/scripts/"; fi
if ! (cd "$DST" && "$NODE_BIN/node" -e "require.resolve('next'); require.resolve('pg')"); then echo "в standalone нет next/pg — проверь сборку"; exit 1; fi

# Отметка схемы: следующий SKIP_DB_MIGRATIONS=1 сверит набор миграций с этой выкладкой.
printf '%s\n' "$CURRENT_SCHEMA" > "$SCHEMA_MARKER"

echo "== перезапуск сайта"
sudo -n systemctl restart neyra-web.service
sleep 3
systemctl is-active neyra-web.service
curl -fsS http://127.0.0.1:3000/api/health && echo
