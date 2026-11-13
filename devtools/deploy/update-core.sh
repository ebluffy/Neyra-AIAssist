#!/usr/bin/env bash
# Обновление установленного ядра Neyra из рабочей копии. Запуск только root:
#   sudo bash /tmp/opencode/update-core.sh [путь к server]
# Проверка без изменений:
#   DRY=1 bash /tmp/opencode/update-core.sh
#
# Что делает: бэкап кода, синхронизация кода без удаления runtime-данных,
# установка requirements в /opt/neyra/server/.venv, compileall. Ядро НЕ
# перезапускает — это отдельное решение владельца.
set -euo pipefail

SRC=${1:-/var/lib/openbot/OpenBot/Shared/NeyraWork/wt-identity/server}
DEST=${DEST:-/opt/neyra/server}
DRY=${DRY:-0}
TS=$(date +%Y%m%d-%H%M%S)
BACKUP="/opt/neyra/server.pre-update-$TS"

EXCLUDES=(
  --exclude '.venv'
  --exclude 'data'
  --exclude 'logs'
  --exclude 'backups'
  --exclude 'models'
  --exclude '.env'
  --exclude 'config.yaml'
  --exclude 'config/'
  --exclude '.deploy-*'
  --exclude '__pycache__'
  --exclude '.pytest_cache'
)

BACKUP_EXCLUDES=(
  --exclude '.venv'
  --exclude 'data'
  --exclude 'logs'
  --exclude 'backups'
  --exclude 'models'
  --exclude '.env'
  --exclude 'config.yaml'
  --exclude 'config/'
  --exclude '__pycache__'
  --exclude '.pytest_cache'
)

[ -f "$SRC/main.py" ] || { echo "нет $SRC/main.py — неверный путь исходников" >&2; exit 1; }
[ -d "$DEST" ] || { echo "нет $DEST — ядро не установлено" >&2; exit 1; }
command -v rsync >/dev/null || { echo "нужен rsync" >&2; exit 1; }

HEAD=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)
echo "источник: $SRC ($HEAD)"
echo "назначение: $DEST"

if [ "$DRY" = 1 ]; then
  echo "== проверка (ничего не меняю)"
  rsync -an --itemize-changes "${EXCLUDES[@]}" "$SRC/" "$DEST/" | sed -n '1,120p'
  count=$(rsync -an --itemize-changes "${EXCLUDES[@]}" "$SRC/" "$DEST/" | grep -c '^[<>ch]' || true)
  echo "изменений: $count"
  echo "для применения: sudo bash $0 $SRC"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "нужен root: sudo bash $0 $SRC" >&2; exit 1; }

echo "== 1/5 бэкап кода в $BACKUP"
mkdir -p "$BACKUP"
rsync -a "${BACKUP_EXCLUDES[@]}" "$DEST/" "$BACKUP"/
[ -f "$DEST/.deploy-sha" ] && cp -a "$DEST/.deploy-sha" "$BACKUP/deploy-sha.before" || true
if [ -x "$DEST/.venv/bin/python" ]; then
  "$DEST/.venv/bin/python" -m pip freeze > "$BACKUP/requirements-frozen.txt" 2>/dev/null || true
fi

echo "== 2/5 синхронизация кода (без удаления данных, конфигов и моделей)"
rsync -a "${EXCLUDES[@]}" "$SRC/" "$DEST/"

echo "== 3/5 зависимости в $DEST/.venv"
[ -x "$DEST/.venv/bin/python" ] || { echo "нет $DEST/.venv — откат: верни код из $BACKUP" >&2; exit 1; }
"$DEST/.venv/bin/python" -m pip install --disable-pip-version-check -r "$DEST/requirements.txt"

echo "== 4/5 compileall"
(cd "$DEST" && .venv/bin/python -m compileall -q core main.py)

echo "== 5/5 отметка сборки"
printf '%s\n' "$HEAD" > "$DEST/.deploy-sha"

cat <<EOF
ядро обновлено, но НЕ перезапущено.
Применить: sudo systemctl restart neyra.service
Проверить: systemctl is-active neyra.service && curl -fsS http://127.0.0.1:8787/v1/health/live
Откат кода: sudo rsync -a --delete --exclude '.venv' --exclude data --exclude logs --exclude backups --exclude models --exclude .env --exclude config.yaml --exclude 'config/' "$BACKUP/" "$DEST/"
[ -f "$BACKUP/deploy-sha.before" ] && sudo cp -a "$BACKUP/deploy-sha.before" "$DEST/.deploy-sha"
зависимости откатываются по $BACKUP/requirements-frozen.txt
EOF
