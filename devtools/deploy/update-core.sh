#!/usr/bin/env bash
# Обновление установленного ядра Neyra из рабочей копии. Запуск только root,
# сервис должен быть уже остановлен:
#   sudo systemctl stop neyra.service
#   sudo bash /tmp/opencode/update-core.sh [путь к server]
#   sudo systemctl start neyra.service
#
# Проверка без изменений: DRY=1 bash /tmp/opencode/update-core.sh
# Скрипт делает полный бэкап /opt/neyra/server (код, .venv, data, config, .env),
# обновляет код и зависимости, проверяет pip check/imports/compileall и при
# любой ошибке сам откатывается целиком. Сервис не запускает и не перезапускает.
set -euo pipefail

SRC=${1:-/var/lib/openbot/OpenBot/Shared/NeyraWork/wt-identity/server}
DEST=${DEST:-/opt/neyra/server}
SERVICE=${SERVICE:-neyra.service}
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

die() { echo "ОШИБКА: $*" >&2; exit 1; }

[ -f "$SRC/main.py" ] || die "нет $SRC/main.py — неверный путь исходников"
[ -f "$DEST/main.py" ] && [ -f "$DEST/core/api/app.py" ] && [ -x "$DEST/.venv/bin/python" ] \
  || die "$DEST не похож на установленное ядро (main.py, core/api/app.py, .venv)"
[ "$(realpath "$DEST")" != "/" ] || die "DEST не может быть корнем"
[ "$(realpath "$SRC")" != "$(realpath "$DEST")" ] || die "SRC и DEST совпадают"
command -v rsync >/dev/null || die "нужен rsync"

HEAD=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)
STATE=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
echo "источник: $SRC ($HEAD)"
echo "назначение: $DEST"
echo "сервис $SERVICE: ${STATE:-unknown}"
[ "$STATE" != "active" ] || echo "внимание: сервис работает; для применения его нужно остановить"

if [ "$DRY" = 1 ]; then
  echo "== проверка (ничего не меняю)"
  rsync -an --itemize-changes "${EXCLUDES[@]}" "$SRC/" "$DEST/" | sed -n '1,120p'
  count=$(rsync -an --itemize-changes "${EXCLUDES[@]}" "$SRC/" "$DEST/" | grep -c '^[<>ch]' || true)
  echo "изменений кода: $count"
  echo "размер полного бэкапа: $(du -sh "$DEST" 2>/dev/null | cut -f1)"
  echo "для применения: sudo systemctl stop $SERVICE && sudo bash $0 $SRC"
  exit 0
fi

[ "$(id -u)" = 0 ] || die "нужен root: sudo bash $0 $SRC"
[ "$STATE" != "active" ] || die "сначала останови сервис: systemctl stop $SERVICE"
if pgrep -f "$DEST/main.py" >/dev/null 2>&1; then die "процесс $DEST/main.py ещё работает"; fi
[ ! -e "$BACKUP" ] || die "бэкап $BACKUP уже существует"

umask 077
echo "== 1/6 полный бэкап в $BACKUP"
cp -a --reflink=auto "$DEST" "$BACKUP" || { rm -rf "$BACKUP"; die "не удалось скопировать $DEST"; }
[ -f "$BACKUP/main.py" ] && [ -x "$BACKUP/.venv/bin/python" ] || die "бэкап неполный: $BACKUP"
chmod 700 "$BACKUP"

restore() {
  echo "== откат из $BACKUP" >&2
  if rsync -a --delete "$BACKUP/" "$DEST/"; then
    echo "откат завершён; данные и окружение вернулись к состоянию до обновления" >&2
  else
    echo "АВТООТКАТ НЕ УДАЛСЯ. Вручную: rsync -a --delete $BACKUP/ $DEST/" >&2
  fi
}
trap 'rc=$?; if [ "$rc" -ne 0 ]; then restore; fi; exit "$rc"' EXIT

echo "== 2/6 синхронизация кода (data/config/models/.env не трогаются)"
rsync -a "${EXCLUDES[@]}" "$SRC/" "$DEST/" || die "rsync кода не удался"

echo "== 3/6 зависимости в $DEST/.venv"
"$DEST/.venv/bin/python" -m pip install --disable-pip-version-check -r "$DEST/requirements.txt" \
  || die "pip install не удался"
"$DEST/.venv/bin/python" -m pip check || die "pip check нашёл сломанные зависимости"

echo "== 4/6 import-smoke без запуска агента"
SMOKE_DATA=$(mktemp -d)
trap 'rc=$?; rm -rf "$SMOKE_DATA"; if [ "$rc" -ne 0 ]; then restore; fi; exit "$rc"' EXIT
(cd "$DEST" && NEYRA_DATA_DIR="$SMOKE_DATA" PYTHONDONTWRITEBYTECODE=1 \
  .venv/bin/python -c "import jwt, core.api.app, core.neyra") || die "import-smoke не прошёл"

echo "== 5/6 compileall"
(cd "$DEST" && PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m compileall -q core main.py) \
  || die "compileall не прошёл"

echo "== 6/6 отметка сборки"
printf '%s\n' "$HEAD" > "$DEST/.deploy-sha"
trap - EXIT
rm -rf "$SMOKE_DATA"

cat <<EOF
ядро обновлено и проверено, сервис НЕ запущен.
Запустить: sudo systemctl start neyra.service
Проверить: systemctl is-active neyra.service && curl -fsS http://127.0.0.1:8787/v1/health/live
Бэкап до обновления (код, .venv, data, config, .env): $BACKUP
Откат: sudo systemctl stop $SERVICE && sudo rsync -a --delete "$BACKUP/" "$DEST/" && sudo systemctl start $SERVICE
EOF
