#!/usr/bin/env bash
# Обновление установленного ядра Neyra из рабочей копии. Запуск только root,
# сервис должен быть остановлен:
#   sudo systemctl stop neyra.service
#   sudo bash devtools/deploy/update-core.sh [путь к server]
#   sudo systemctl start neyra.service
#
# Проверка без изменений: DRY=1 bash devtools/deploy/update-core.sh
# Скрипт делает полный бэкап /opt/neyra/server (код, .venv, data, config, .env),
# обновляет код и зависимости, проверяет pip check/imports/compileall и при
# любой ошибке сам откатывается целиком. Сервис не запускает и не перезапускает.
set -euo pipefail

SRC=${1:-$(cd "$(dirname "$0")/../../server" && pwd)}
DEST_RAW=${DEST:-/opt/neyra/server}
SERVICE=${SERVICE:-neyra.service}
DRY=${DRY:-0}
TS=$(date +%Y%m%d-%H%M%S)

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

service_idle() {
  # Разрешаем только подтверждённый inactive/failed без ожидающих jobs.
  local active sub jobs
  active=$(systemctl show -p ActiveState --value "$SERVICE" 2>/dev/null) || return 1
  sub=$(systemctl show -p SubState --value "$SERVICE" 2>/dev/null) || return 1
  jobs=$(systemctl list-jobs "$SERVICE" --no-legend --plain 2>/dev/null) || return 1
  [ -z "$jobs" ] || return 1
  case "$active" in
    inactive|failed) ;;
    *) return 1 ;;
  esac
  case "$sub" in
    dead|failed) return 0 ;;
    *) return 1 ;;
  esac
}

core_process_running() {
  pgrep -f "$DEST/main.py" >/dev/null 2>&1
}

[ -f "$SRC/main.py" ] || die "нет $SRC/main.py — неверный путь исходников"
command -v rsync >/dev/null || die "нужен rsync"
[ -d "$DEST_RAW" ] || die "нет $DEST_RAW"
DEST=$(realpath -e "$DEST_RAW" 2>/dev/null) || die "не удалось разрешить путь $DEST_RAW"
[ -f "$DEST/main.py" ] && [ -f "$DEST/core/api/app.py" ] && [ -x "$DEST/.venv/bin/python" ] \
  || die "$DEST не похож на установленное ядро (main.py, core/api/app.py, .venv)"
[ "$DEST" != "/" ] || die "DEST не может быть корнем"
[ "$(realpath "$SRC")" != "$DEST" ] || die "SRC и DEST совпадают"
for name in .venv data config models backups logs .env config.yaml; do
  [ ! -L "$DEST/$name" ] || die "$DEST/$name — символьная ссылка: полный снимок и откат невозможны, замени на обычный путь"
done
# Вложенные ссылки в данных/конфиге не копируются содержимым, а остаются ссылками.
nested_link=$(find "$DEST/data" "$DEST/config" -type l -print -quit 2>/dev/null || true)
[ -z "$nested_link" ] || die "в data/config есть симлинк $nested_link — полный снимок невозможен"

GIT_ROOT=$(git -C "$SRC" -c safe.directory='*' rev-parse --show-toplevel 2>/dev/null) \
  || die "$SRC не в git-репозитории: выкладка возможна только из закоммиченного кода"
# Один вход в git: safe.directory для root/чужого владельца, ошибки не глотаем.
g() { git -C "$GIT_ROOT" -c safe.directory="$GIT_ROOT" "$@"; }
REL=$(realpath --relative-to="$GIT_ROOT" "$SRC")
[ "$REL" = "server" ] || die "ожидается каталог server/ в корне репозитория, получено $REL"
DIRTY=$(g status --porcelain) || die "git status не выполнился — состояние рабочей копии неизвестно"
[ -z "$DIRTY" ] || die "рабочая копия грязная: закоммить или stash изменения перед выкладкой"
HEAD=$(g rev-parse HEAD) || die "не удалось определить HEAD"
command -v tar >/dev/null || die "нужен tar"

# Выкладываем только файлы коммита: gitignored данные/конфиги рабочей копии
# не попадают в архив и не могут перезаписать боевые (AR-20).
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
g archive "$HEAD" -- "$REL" | tar -x -C "$STAGE" --strip-components=1 \
  || die "git archive HEAD не удался"
[ -f "$STAGE/main.py" ] || die "в архиве коммита нет main.py"
SYNC_SRC="$STAGE"
echo "источник: $SRC ($HEAD, git archive)"
echo "назначение: $DEST"
if service_idle; then
  echo "сервис $SERVICE: остановлен или failed без jobs"
  core_process_running && echo "внимание: найден процесс $DEST/main.py — для применения его нужно остановить"
elif [ "$DRY" = 1 ]; then
  echo "внимание: сервис $SERVICE не в подтверждённом inactive/failed — для применения его нужно остановить"
else
  die "сервис $SERVICE не в подтверждённом inactive/failed (или systemctl недоступен): останови его и проверь systemctl status"
fi

BACKUP_PARENT=${BACKUP_ROOT:-/opt/neyra}
[ -d "$BACKUP_PARENT" ] || die "нет каталога для бэкапа: $BACKUP_PARENT"

if [ "$DRY" = 1 ]; then
  echo "== проверка (ничего не меняю)"
  rsync -an --itemize-changes "${EXCLUDES[@]}" "$SYNC_SRC/" "$DEST/" | sed -n '1,120p'
  count=$(rsync -an --itemize-changes "${EXCLUDES[@]}" "$SYNC_SRC/" "$DEST/" | grep -c '^[<>ch]' || true)
  echo "изменений кода: $count"
  echo "размер полного бэкапа: $(du -sh "$DEST" 2>/dev/null | cut -f1)"
  echo "свободно под бэкап на $(df -P "$BACKUP_PARENT" | awk 'NR==2 {print $6}'): $(df -Ph "$BACKUP_PARENT" | awk 'NR==2 {print $4}')"
  echo "для применения: sudo systemctl stop $SERVICE && sudo bash $0 $SRC"
  exit 0
fi

[ "$(id -u)" = 0 ] || die "нужен root: sudo bash $0 $SRC"
service_idle || die "перед обновлением сервис $SERVICE должен быть inactive/failed без jobs"
core_process_running && die "найден живой процесс $DEST/main.py — останови его, иначе SQLite-снимок несогласован"

"$DEST/.venv/bin/python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' \
  || die "в $DEST/.venv Python старше 3.11"

BACKUP="$BACKUP_PARENT/server.pre-update-$TS"
[ ! -e "$BACKUP" ] || die "бэкап $BACKUP уже существует"

NEED_BYTES=$(du -sb "$DEST" | cut -f1)
AVAIL_BYTES=$(df -PB1 "$BACKUP_PARENT" | awk 'NR==2 {print $4}')
RESERVE=$((NEED_BYTES / 5 + 1073741824))
[ "$AVAIL_BYTES" -gt $((NEED_BYTES + RESERVE)) ] \
  || die "мало места под бэкап в $BACKUP_PARENT: нужно ~$(( (NEED_BYTES + RESERVE) / 1073741824 + 1 )) ГиБ"
NEED_INODES=$(find "$DEST" | wc -l)
AVAIL_INODES=$(df -Pi "$BACKUP_PARENT" | awk 'NR==2 {print $4}')
[ "$AVAIL_INODES" -gt $((NEED_INODES + NEED_INODES / 10)) ] \
  || die "мало inode под бэкап в $BACKUP_PARENT"

umask 077
service_idle || die "сервис $SERVICE запустился между проверками — обновление отменено"
core_process_running && die "процесс $DEST/main.py появился между проверками — обновление отменено"
echo "== 1/6 полный бэкап в $BACKUP"
cp -a --reflink=auto "$DEST" "$BACKUP" || { rm -rf "$BACKUP"; die "не удалось скопировать $DEST"; }
[ -f "$BACKUP/main.py" ] && [ -x "$BACKUP/.venv/bin/python" ] || { rm -rf "$BACKUP"; die "бэкап неполный: $BACKUP"; }
chmod 700 "$BACKUP"

restore() {
  echo "== откат из $BACKUP" >&2
  if rsync -a --delete "$BACKUP/" "$DEST/"; then
    echo "откат завершён; данные и окружение вернулись к состоянию до обновления" >&2
  else
    echo "АВТООТКАТ НЕ УДАЛСЯ. Вручную: rsync -a --delete $BACKUP/ $DEST/" >&2
  fi
}
trap 'rc=$?; rm -rf "$STAGE"; if [ "$rc" -ne 0 ]; then restore; fi; exit "$rc"' EXIT

echo "== 2/6 синхронизация кода (data/config/models/.env не трогаются)"
rsync -a --no-owner --no-group --chown=root:root "${EXCLUDES[@]}" "$SYNC_SRC/" "$DEST/" \
  || die "rsync кода не удался"

echo "== 3/6 зависимости в $DEST/.venv"
"$DEST/.venv/bin/python" -m pip install --disable-pip-version-check -r "$DEST/requirements.txt" \
  || die "pip install не удался"
"$DEST/.venv/bin/python" -m pip check || die "pip check нашёл сломанные зависимости"

echo "== 4/6 import-smoke без запуска агента"
SMOKE_DATA=$(mktemp -d)
trap 'rc=$?; rm -rf "$SMOKE_DATA" "$STAGE"; if [ "$rc" -ne 0 ]; then restore; fi; exit "$rc"' EXIT
(cd "$DEST" && NEYRA_DATA_DIR="$SMOKE_DATA" PYTHONDONTWRITEBYTECODE=1 \
  .venv/bin/python -c "import jwt, core.api.app, core.neyra") || die "import-smoke не прошёл"

echo "== 5/6 compileall"
(cd "$DEST" && PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m compileall -q core main.py) \
  || die "compileall не прошёл"

echo "== 6/6 отметка сборки"
printf '%s\n' "$HEAD" > "$DEST/.deploy-sha"
trap - EXIT
rm -rf "$SMOKE_DATA" "$STAGE"

cat <<EOF
ядро обновлено и проверено, сервис НЕ запущен.
Запустить: sudo systemctl start $SERVICE
Проверить: systemctl is-active $SERVICE && curl -fsS http://127.0.0.1:8787/v1/health/live
Бэкап до обновления (код, .venv, data, config, .env): $BACKUP

ВНИМАНИЕ: откат ниже вернёт и данные к моменту бэкапа — всё, что новое ядро
запишет после запуска (память, база, файлы), будет потеряно. Если эти данные
нужны, сначала сохрани их отдельно.
Откат: sudo systemctl stop $SERVICE && sudo rsync -a --delete "$BACKUP/" "$DEST/" && sudo systemctl start $SERVICE
EOF
