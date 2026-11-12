#!/usr/bin/env bash
# Сборка, миграции и выкладка сайта Neyra. Root не нужен:
# перезапуск юнита разрешён узким правилом sudoers из neyra-web-setup.sh.
#
# Использование: bash /tmp/opencode/deploy-web.sh [путь к web]
# По умолчанию берётся ветка чата (P2), если её worktree есть, иначе P1.
set -euo pipefail

DEFAULT_SRC=/var/lib/openbot/OpenBot/Shared/NeyraWork/wt-web2/web
[ -d "$DEFAULT_SRC" ] || DEFAULT_SRC=/var/lib/openbot/OpenBot/Shared/NeyraWork/wt-p1/web
SRC="${1:-$DEFAULT_SRC}"
DST=/opt/neyra/web/app
ENV_FILE=/opt/neyra/web/.env
NODE_BIN=/opt/neyra/web/node/bin

if [ ! -x "$NODE_BIN/node" ]; then
  echo "Нет Node 22 в $NODE_BIN — сначала выполни: sudo bash /tmp/opencode/neyra-web-setup.sh"
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Нет $ENV_FILE — сначала выполни: sudo bash /tmp/opencode/neyra-web-setup.sh"
  exit 1
fi

export PATH="$NODE_BIN:/tmp/opencode/node-v22.23.4-linux-x64/bin:$PATH"

echo "== переменные окружения площадки"
set -a; . "$ENV_FILE"; set +a
for v in NEYRA_WS_URL NEYRA_SERVICE_KEY NEYRA_IDENTITY_JWT_SECRET; do
  if [ -z "${!v:-}" ]; then echo "внимание: $v пуст — чат сайта вернёт 503" >&2; fi
done

ROOT="$(dirname "$SRC")"   # корень монорепо: здесь npm workspaces
echo "== сборка из $ROOT"
cd "$ROOT"
npm ci --no-audit --no-fund
npm run build

cd "$SRC"                  # web/
STAGE=.next/standalone
[ -f "$STAGE/web/server.js" ] || { echo "Нет $STAGE/web/server.js — проверь output: 'standalone'"; exit 1; }

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
