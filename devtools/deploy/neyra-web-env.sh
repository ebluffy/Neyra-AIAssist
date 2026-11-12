#!/usr/bin/env bash
# Синхронизация секретов сайта с ядром Neyra. Идемпотентно, значения не печатает.
# Нужен root: пишет в /opt/neyra/web/.env и (только при первой генерации) в
# /opt/neyra/server/.env. Ядро подхватит новый секрет после перезапуска.
#
# Переменные: WEB, CORE (по умолчанию /opt/neyra/web, /opt/neyra/server).
set -euo pipefail

WEB=${WEB:-/opt/neyra/web}
CORE=${CORE:-/opt/neyra/server}
WEB_ENV="$WEB/.env"
CORE_ENV="$CORE/.env"
[ -f "$WEB_ENV" ] || { echo "нет $WEB_ENV — сначала запусти neyra-web-setup.sh" >&2; exit 1; }

env_value() { # env_value FILE KEY
  [ -r "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -1 | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

PORT=$(python3 - "$CORE" <<'PY' 2>/dev/null || true
import sys, yaml
try:
    cfg = yaml.safe_load(open(sys.argv[1] + '/config/server.yaml'))
    api = (cfg or {}).get('api') or {}
    port = int(api.get('port') or 0)
    print(port if port > 0 else '')
except Exception:
    pass
PY
)
PORT=${PORT:-8787}

SERVICE_KEY=$(env_value "$CORE_ENV" API_TOKEN)
if [ -z "$SERVICE_KEY" ]; then SERVICE_KEY=$(env_value "$CORE_ENV" API_KEY); fi

CORE_SECRET_ADDED=0
IDENTITY_SECRET=$(env_value "$CORE_ENV" NEYRA_IDENTITY_JWT_SECRET)
if [ -z "$IDENTITY_SECRET" ]; then
  IDENTITY_SECRET=$(openssl rand -hex 32)
  if [ -w "$CORE_ENV" ]; then
    {
      printf '\n# Подпись X-Neyra-Identity для сайта; тот же секрет в /opt/neyra/web/.env.\n'
      printf 'NEYRA_IDENTITY_JWT_SECRET=%s\n' "$IDENTITY_SECRET"
    } >> "$CORE_ENV"
    CORE_SECRET_ADDED=1
  else
    echo "не могу записать $CORE_ENV — секрет identity остался только у сайта" >&2
  fi
fi

# Обновляем только пустые/отсутствующие ключи; заданные вручную значения не трогаем.
NEYRA_WS_URL="ws://127.0.0.1:${PORT}" \
NEYRA_API_URL="http://127.0.0.1:${PORT}" \
NEYRA_SERVICE_KEY="$SERVICE_KEY" \
NEYRA_IDENTITY_JWT_SECRET="$IDENTITY_SECRET" \
python3 - "$WEB_ENV" <<'PY'
import os, sys
path = sys.argv[1]
keys = ("NEYRA_WS_URL", "NEYRA_API_URL", "NEYRA_SERVICE_KEY", "NEYRA_IDENTITY_JWT_SECRET")
lines = open(path, encoding="utf-8").read().splitlines()
present = {}
for i, line in enumerate(lines):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        present[k.strip()] = (i, v.strip())
for key in keys:
    value = os.environ.get(key, "")
    if key not in present:
        lines.append(f"{key}={value}")
    elif not present[key][1] and value:
        lines[present[key][0]] = f"{key}={value}"
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
chmod 600 "$WEB_ENV" 2>/dev/null || true

if [ -z "$SERVICE_KEY" ]; then
  echo "внимание: в $CORE_ENV нет API_TOKEN/API_KEY — впиши NEYRA_SERVICE_KEY вручную" >&2
fi
WEB_IDENTITY=$(env_value "$WEB_ENV" NEYRA_IDENTITY_JWT_SECRET)
if [ -n "$WEB_IDENTITY" ] && [ "$WEB_IDENTITY" != "$IDENTITY_SECRET" ]; then
  echo "внимание: NEYRA_IDENTITY_JWT_SECRET сайта не совпадает с ядром — подпись будет отклонена" >&2
fi
if [ "$CORE_SECRET_ADDED" = 1 ]; then
  echo "секрет identity добавлен в $CORE_ENV (значение не печатаю)"
  echo "ядру нужен один перезапуск, чтобы принять новый секрет: sudo systemctl restart neyra.service"
fi
echo "env сайта синхронизирован: $WEB_ENV"
