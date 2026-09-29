#!/usr/bin/env bash
# Neyra launcher — Linux/macOS «серверное» меню с статус-баром.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="${ROOT}/server"
cd "$SERVER"

if [[ -t 1 ]]; then
  _R=$'\033[31m'
  _G=$'\033[32m'
  _Y=$'\033[33m'
  _C=$'\033[36m'
  _M=$'\033[35m'
  _B=$'\033[1m'
  _Z=$'\033[0m'
else
  _R=_G=_Y=_C=_M=_B=_Z=''
fi

# В WSL первым в PATH часто оказываются Windows *.exe (python/node/npm) — они не работают с /mnt/... путями.
is_windows_host_binary() {
  local p="$1"
  case "${p}" in
    *.exe|*.EXE|*.cmd|*.CMD|*.bat|*.BAT) return 0 ;;
    /mnt/c/Users/*/AppData/Local/Programs/Python/*) return 0 ;;
    /mnt/c/Users/*/AppData/Local/Microsoft/WindowsApps/python*) return 0 ;;
    /mnt/c/Users/*/AppData/Local/Microsoft/WindowsApps/npm*) return 0 ;;
  esac
  return 1
}

command_is_posix() {
  local name="$1"
  local full=""
  command -v "${name}" >/dev/null 2>&1 || return 1
  full="$(command -v "${name}")"
  if is_windows_host_binary "${full}"; then
    return 1
  fi
  return 0
}

resolve_python_candidate() {
  local name="$1"
  local full=""
  command -v "${name}" >/dev/null 2>&1 || return 1
  full="$(command -v "${name}")"
  if is_windows_host_binary "${full}"; then
    return 1
  fi
  printf '%s' "${full}"
  return 0
}

is_wsl() {
  [[ "$(uname -s 2>/dev/null)" == Linux ]] && [[ -r /proc/version ]] && [[ "$(</proc/version)" == *[Mm]icrosoft* ]]
}

# On WSL + /mnt/<drive>/… a Linux venv in the repo looks like a broken “file” in Windows Explorer
# (symlink/junction). Prefer ~/neyra-venv on ext4 instead of putting .venv on the Windows volume.
linux_venv_candidates() {
  echo "${ROOT}/.venv"
  if is_wsl && [[ "${ROOT}" == /mnt/* ]]; then
    echo "${HOME}/neyra-venv"
  fi
}

select_python() {
  local p="" cand=""
  for cand in $(linux_venv_candidates); do
    if [[ -x "${cand}/bin/python" ]] && "${cand}/bin/python" -c 'import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)' >/dev/null 2>&1; then
      PY="${cand}/bin/python"
      return 0
    fi
  done
  # venv с Windows: в WSL лучше поставить Linux-venv (.venv/bin/python), но если только exe — пропускаем в WSL
  if [[ -x "${ROOT}/.venv/Scripts/python.exe" ]]; then
    if is_wsl; then
      :
    else
      PY="${ROOT}/.venv/Scripts/python.exe"
      return 0
    fi
  fi
  for p in /usr/bin/python3 /usr/local/bin/python3; do
    if [[ -x "${p}" ]] && ! is_windows_host_binary "${p}"; then
      PY="${p}"
      return 0
    fi
  done
  local try name
  for name in python3 python3.12 python3.11 python3.10 python; do
    try="$(resolve_python_candidate "${name}" 2>/dev/null || true)"
    if [[ -n "${try}" ]]; then
      PY="${try}"
      return 0
    fi
  done
  return 1
}

if ! select_python; then
  echo "${_R}[ERR]${_Z} Нейра: не найден подходящий Python для этой ОС (нужен Linux/macOS Python, не Windows .exe из WSL PATH)."
  echo "${_C}Подсказка (WSL/Ubuntu): sudo apt update && sudo apt install -y python3 python3-venv python3-pip${_Z}"
  exit 1
fi

PIP="${PY} -m pip"
LL_DIR="${SERVER}/modules/discord/lavalink"
LOG_SYS="${SERVER}/logs/system.log"

say() { echo "${_C}${*}${_Z}"; }
ok()  { echo "${_G}[OK]${_Z} ${*}"; }
warn(){ echo "${_Y}[WARN]${_Z} ${*}"; }
err() { echo "${_R}[ERR]${_Z} ${*}"; }

# Схема venv: Linux/macOS — .venv/bin; WSL на /mnt — часто ~/neyra-venv; Windows — .venv_win (см. scripts/neyra_win_launcher.ps1).
if [[ "${PY}" == *"/neyra-venv/bin/python"* ]] || [[ "${PY}" == *"/.venv/bin/python"* ]] || [[ "${PY}" == *"/.venv_win/Scripts/python.exe"* ]] || [[ "${PY}" == *"\\.venv_win\\Scripts\\python.exe"* ]]; then
  ok "Активный Python: ${PY} (проектный Linux/WSL venv или .venv_win)"
elif [[ "${PY}" == *"/.venv/Scripts/python.exe"* ]] || [[ "${PY}" == *"\\.venv\\Scripts\\python.exe"* ]]; then
  ok "Активный Python: ${PY} (fallback .venv\\Scripts — на WSL лучше Linux-venv; на Windows лучше .venv_win)"
else
  ok "Активный Python: ${PY} (системный/PATH; pip после согласия — туда же, пока не создан/не выбран project venv)"
fi

ensure_project_venv() {
  local base_py="${PY}"
  local venv_dir="${ROOT}/.venv"
  local cand=""
  for cand in $(linux_venv_candidates); do
    if [[ -x "${cand}/bin/python" ]]; then
      PY="${cand}/bin/python"
      PIP="${PY} -m pip"
      return 0
    fi
  done
  if is_wsl && [[ "${ROOT}" == /mnt/* ]]; then
    venv_dir="${HOME}/neyra-venv"
    warn "WSL + диск /mnt: создаю Linux-venv в ${venv_dir} (не в репо — иначе Windows видит .venv как файл-junction)."
  else
    warn "Создаю локальное окружение .venv (PEP 668 / безопасная установка зависимостей)..."
  fi
  if ! "${base_py}" -m venv "${venv_dir}"; then
    err "Не удалось создать venv (${venv_dir}). На Ubuntu установи: python3-venv"
    return 1
  fi
  PY="${venv_dir}/bin/python"
  PIP="${PY} -m pip"
  "${PY}" -m ensurepip --upgrade >/dev/null 2>&1 || true
  if ! ${PIP} install --upgrade pip >/dev/null 2>&1; then
    warn "Не удалось обновить pip внутри .venv — продолжаю с текущим."
  fi
  ok "Переключилась на project venv: ${PY}"
  return 0
}

banner() {
  echo ""
  echo "${_M}${_B}  ███╗   ██╗███████╗██╗   ██╗██████╗  █████╗ ${_Z}"
  echo "${_M}${_B}  ██╔██╗ ██║██╔════╝╚██╗ ██╔╝██╔══██╗██╔══██╗${_Z}"
  echo "${_M}${_B}  ██║╚██╗██║█████╗   ╚████╔╝ ██████╔╝███████║${_Z}"
  echo "${_M}${_B}  ██║ ╚████║██╔══╝    ╚██╔╝  ██╔══██╗██╔══██║${_Z}"
  echo "${_M}${_B}  ██║  ╚███║███████╗   ██║   ██║  ██║██║  ██║${_Z}"
  echo "${_M}${_B}  ╚═╝   ╚══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝${_Z}"
  echo "${_C}         // neural stack · server control${_Z}"
  echo ""
}

core_pid() {
  pgrep -f "[m]ain.py --mode core" 2>/dev/null | head -n1 || true
}

lavalink_pid() {
  pgrep -f "[L]avalink.jar" 2>/dev/null | head -n1 || true
}

status_bar() {
  local cp lp
  cp="$(core_pid)"
  lp="$(lavalink_pid)"
  echo "${_B}─── статус процессов ───${_Z}"
  if [[ -n "${cp}" ]]; then
    echo "${_G}[🟢 ONLINE]${_Z} Core     ${_C}(PID: ${cp})${_Z}"
  else
    echo "${_R}[🔴 OFFLINE]${_Z} Core"
  fi
  if [[ -n "${lp}" ]]; then
    echo "${_G}[🟢 ONLINE]${_Z} Lavalink ${_C}(PID: ${lp})${_Z}"
  else
    echo "${_R}[🔴 OFFLINE]${_Z} Lavalink"
  fi
  echo "${_B}────────────────────────${_Z}"
}

start_lavalink_background() {
  local jar="${LL_DIR}/Lavalink.jar"
  local cfg="${LL_DIR}/application.yml"
  local cfg_example="${LL_DIR}/application.example.yml"
  local logf="${LL_DIR}/lavalink.log"
  if [[ ! -f "${jar}" ]]; then
    warn "Lavalink.jar не найден: ${jar}"
    say "Запусти из корня репозитория: cd \"${ROOT}\" && \"${PY}\" scripts/fetch_lavalink.py"
    return 0
  fi
  if [[ ! -f "${cfg}" && -f "${cfg_example}" ]]; then
    cp -f "${cfg_example}" "${cfg}"
    ok "Создала application.yml из примера."
  fi
  local jar_size=0
  jar_size="$(wc -c < "${jar}" | tr -d '[:space:]')"
  if [[ "${jar_size}" -lt 1048576 ]]; then
    warn "JAR слишком маленький (${jar_size} B) — похоже на Git LFS pointer."
    say "Запусти: cd \"${ROOT}\" && \"${PY}\" scripts/fetch_lavalink.py"
    return 0
  fi
  if ! "${PY}" scripts/fetch_lavalink_plugins.py --config "${cfg}" --latest-youtube; then
    warn "Плагины Lavalink не готовы (часто Git LFS pointer в plugins/*.jar)."
    say "Запусти: cd \"${ROOT}\" && \"${PY}\" scripts/fetch_lavalink_plugins.py"
    return 0
  fi
  if command -v pgrep >/dev/null 2>&1 && pgrep -f "[L]avalink.jar" >/dev/null 2>&1; then
    ok "Lavalink уже в фоне."
    return 0
  fi
  say "Стартую Lavalink в фоне..."
  (
    cd "${LL_DIR}" || exit 1
    nohup java -Dfile.encoding=UTF-8 -jar Lavalink.jar > "${logf}" 2>&1 &
  )
  sleep 2
  ok "Lavalink должна слушать порт из application.yml."
}

stop_lavalink() {
  say "Гашу Lavalink..."
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "[L]avalink.jar" 2>/dev/null || true
    ok "Сигнал отправлен."
  else
    warn "pkill нет — останови Lavalink вручную."
  fi
}

stop_core() {
  say "Гашу ядро (main.py --mode core)..."
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "[m]ain.py --mode core" 2>/dev/null || true
    ok "Сигнал отправлен."
  else
    warn "pkill нет — останови процесс вручную."
  fi
}

stop_all() {
  say "Полная остановка: Lavalink + Core."
  stop_lavalink
  stop_core
}

tail_system_log() {
  if [[ ! -f "${LOG_SYS}" ]]; then
    warn "Файла нет: ${LOG_SYS}"
    say "Если ядро пишет лог в другое место — проверь config.yaml → logging.system_log."
    return 0
  fi
  echo "${_B}─── последние 20 строк ${LOG_SYS} ───${_Z}"
  tail -n 20 "${LOG_SYS}" 2>/dev/null || warn "Не смогла прочитать лог."
}

check_system_deps() {
  say "Проверяю инструменты: git, ffmpeg, Java, Node.js, npm и версию Python (>=3.10)..."
  local missing=()
  command_is_posix git || missing+=("git")
  command_is_posix ffmpeg || missing+=("ffmpeg")
  command_is_posix java || missing+=("java")
  command_is_posix node || missing+=("nodejs")
  command_is_posix npm || missing+=("npm")
  if ! "${PY}" -c 'import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)' >/dev/null 2>&1; then
    missing+=("python3.10+")
  fi

  if ((${#missing[@]} > 0)); then
    warn "Отсутствуют или не подходят зависимости: ${missing[*]}"
    read -r -p "Попытаться установить/починить автоматически? [y/N]: " auto_install
    if [[ "${auto_install}" =~ ^[yY]$ ]]; then
      if command -v apt >/dev/null 2>&1; then
        local apt_cmd="apt update && apt install -y git ffmpeg openjdk-17-jre-headless nodejs npm python3 python3-venv python3-pip"
        if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
          apt_cmd="sudo ${apt_cmd}"
        fi
        say "Пробую авто-установку через apt..."
        if ! bash -lc "${apt_cmd}"; then
          warn "apt завершился с ошибкой."
        fi
      elif command -v brew >/dev/null 2>&1; then
        say "Пробую авто-установку через Homebrew..."
        if ! brew install git ffmpeg openjdk@17 node; then
          warn "brew install завершился с ошибкой."
        fi
      else
        warn "Нет apt и brew — авто-установка недоступна на этой системе."
      fi
      hash -r 2>/dev/null || true
      if ! select_python; then
        err "После авто-установки не удалось снова выбрать подходящий Python."
        return 1
      fi
      PIP="${PY} -m pip"
    fi
  else
    ok "Системные утилиты и версия Python в порядке."
  fi

  local still=()
  command_is_posix git || still+=("git")
  command_is_posix ffmpeg || still+=("ffmpeg")
  command_is_posix java || still+=("java")
  command_is_posix node || still+=("nodejs")
  command_is_posix npm || still+=("npm")
  if ! "${PY}" -c 'import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)' >/dev/null 2>&1; then
    still+=("python3.10+")
  fi
  if ((${#still[@]} > 0)); then
    warn "Все ещё проблемы: ${still[*]}"
    say "Git: https://git-scm.com/"
    say "FFmpeg: https://ffmpeg.org/download.html"
    say "Java 17 (для Lavalink): https://adoptium.net/temurin/releases/?version=17"
    say "Node.js (для frontend): https://nodejs.org/"
    say "Python 3.10+: https://www.python.org/downloads/"
  elif ((${#missing[@]} > 0)); then
    ok "Системный стек установлен / исправлен."
  fi

  if command_is_posix java; then
    local java_major
    java_major="$(java -version 2>&1 | awk -F[\".] '/version/ { if ($2 == "1") print $3; else print $2; exit }')"
    if [[ -n "${java_major}" ]]; then
      if (( java_major < 11 )); then
        warn "Найдена Java ${java_major}. Для Lavalink v4 нужна Java 11+, рекомендуется 17."
      elif (( java_major < 17 )); then
        warn "Найдена Java ${java_major}. Работать может, но рекомендуется Java 17."
      else
        ok "Java версии ${java_major} — отлично для Lavalink."
      fi
    fi
  fi

  if command_is_posix node; then
    local node_major
    node_major="$(node -v 2>/dev/null | sed -e 's/^v//' -e 's/\..*//')"
    if [[ -n "${node_major}" ]] && [[ "${node_major}" =~ ^[0-9]+$ ]]; then
      if (( node_major < 18 )); then
        warn "Node.js major=${node_major}: для Vite 8 (frontend) обычно нужен Node 18+."
      else
        ok "Node.js major=${node_major} — подходит для dev/build фронтенда."
      fi
    fi
  fi
}

check_frontend_deps() {
  local fr="${ROOT}/frontend"
  [[ -f "${fr}/package.json" ]] || return 0
  say "Проверяю frontend (npm)..."
  if ! command_is_posix node || ! command_is_posix npm; then
    warn "Node.js/npm недоступны как POSIX-команды — пропускаю frontend (см. системные зависимости выше)."
    return 0
  fi
  if [[ ! -d "${fr}/node_modules" ]]; then
    warn "Нет каталога dashboard/node_modules."
    read -r -p "Запустить npm ci в dashboard/? [y/N]: " yn
    if [[ "${yn}" =~ ^[yY]$ ]]; then
      (cd "${fr}" && npm ci) || (cd "${fr}" && npm install) || warn "npm install/ci не удался — проверь вывод выше."
    fi
  else
    ok "dashboard/node_modules на месте."
  fi
}

check_python_deps() {
  say "Проверяю Python-модули для интерпретатора: ${PY}"
  local missing=()
  local modules=(
    yaml dotenv requests httpx fastapi uvicorn discord wavelink PIL
    langchain langchain_openai langchain_community chromadb sentence_transformers apscheduler ddgs nacl
  )
  local m
  for m in "${modules[@]}"; do
    if ! "${PY}" -c "import ${m}" >/dev/null 2>&1; then
      missing+=("${m}")
    fi
  done
  if ((${#missing[@]} > 0)); then
    warn "Не хватает: ${missing[*]}"
    read -r -p "Нейра: поставить из requirements.txt? [y/N]: " yn
    if [[ ! "${yn}" =~ ^[yY]$ ]]; then
      err "Без модулей я не запущу ядро."
      return 1
    fi
    local pip_log
    pip_log="$(mktemp)"
    say "Ставлю Python-зависимости (это может занять несколько минут, показываю прогресс)..."
    if ! ${PIP} install -r requirements.txt 2>&1 | tee "${pip_log}"; then
      if [[ -r "${pip_log}" ]] && [[ "$(cat "${pip_log}")" == *"externally-managed-environment"* ]]; then
        warn "Сработала защита PEP 668 (externally managed). Перехожу на локальный .venv..."
        if ! ensure_project_venv; then
          rm -f "${pip_log}" 2>/dev/null || true
          return 1
        fi
        say "Повторяю установку внутри .venv (с прогрессом)..."
        if ! ${PIP} install -r requirements.txt 2>&1 | tee "${pip_log}"; then
          err "pip install в .venv провалился."
          rm -f "${pip_log}" 2>/dev/null || true
          return 1
        fi
      else
        err "pip install провалился."
        rm -f "${pip_log}" 2>/dev/null || true
        return 1
      fi
    fi
    rm -f "${pip_log}" 2>/dev/null || true
    ok "Зависимости подтянуты."
  else
    ok "Все нужные модули на борту."
  fi
}

run_initial_healthcheck() {
  say "Healthcheck (console)..."
  local hc_log
  hc_log="$(mktemp)"
  if ! "${PY}" scripts/healthcheck.py --mode console --skip-http 2>&1 | tee "${hc_log}"; then
    warn "Healthcheck FAIL — см. строки Status: FAIL выше."
    say "Повтор: ${PY} scripts/healthcheck.py --mode console --skip-http"
    say "Секреты: .env | конфиг: config.yaml | лог: logs/system.log"
    rm -f "${hc_log}" 2>/dev/null || true
    read -r -p "Продолжить всё равно? [y/N]: " yn
    [[ "${yn}" =~ ^[yY]$ ]] || return 1
  else
    ok "Healthcheck: ок."
    rm -f "${hc_log}" 2>/dev/null || true
  fi
}

run_voice_preflight() {
  # Soft-only: always continues (STT/TTS misconfig must not block core).
  say "Voice preflight (STT/TTS)..."
  "${PY}" scripts/voice_preflight.py || true
  echo ""
}

run_preflight() {
  banner
  say "Инициализация системных модулей... сканирую окружение, босс."
  echo ""
  check_system_deps || return 1
  check_python_deps || return 1
  check_frontend_deps || true
  run_initial_healthcheck || return 1
  run_voice_preflight
  say "Нейра готова к запуску. Что будем делать дальше, босс?"
  echo ""
  return 0
}

run_preflight || exit 1

while true; do
  banner
  status_bar
  echo ""
  say "Главное меню — выбери режим цифрой."
  echo "  ${_M}1${_Z}) Консоль — только диалог с моделью"
  echo "  ${_M}2${_Z}) Полное ядро — API, dashboard, плагины (спрошу про Lavalink)"
  echo "  ${_M}3${_Z}) Только Lavalink — фон"
  echo "  ${_M}4${_Z}) Остановить только Core"
  echo "  ${_M}5${_Z}) Остановить только Lavalink"
  echo "  ${_M}6${_Z}) Остановить всё (Core + Lavalink)"
  echo "  ${_M}7${_Z}) Хвост лога: последние 20 строк logs/system.log"
  echo "  ${_M}8${_Z}) Починить Lavalink.jar + плагины (fetch с GitHub)"
  echo "  ${_M}9${_Z}) Повторить проверки зависимостей"
  echo "  ${_M}0${_Z}) Выход"
  echo ""
  read -r -p "Твой выбор [0-9]: " choice

  case "${choice}" in
    1)
      ok "Запускаю консольный режим."
      "${PY}" main.py --mode console || true
      say "Консоль завершилась."
      ;;
    2)
      say "Прогоняю healthcheck для core..."
      if ! "${PY}" scripts/healthcheck.py --mode core --skip-http; then
        warn "Healthcheck core FAIL — см. вывод выше (Status: FAIL и подсказки ->)."
        say "Повтор: ${PY} scripts/healthcheck.py --mode core --skip-http"
        read -r -p "Продолжить? [y/N]: " yn
        [[ "${yn}" =~ ^[yY]$ ]] || continue
      fi
      echo ""
      read -r -p "Запустить Lavalink автоматически перед ядром? [y/N]: " la
      if [[ "${la}" =~ ^[yY]$ ]]; then
        start_lavalink_background
      else
        say "Ок, Lavalink не трогаю — поднимай отдельно (п.3) или оставь уже запущенный."
      fi
      ok "Стартую ядро: main.py --mode core"
      "${PY}" main.py --mode core || true
      say "Ядро остановилось."
      ;;
    3)
      start_lavalink_background
      ;;
    4)
      stop_core
      ;;
    5)
      stop_lavalink
      ;;
    6)
      stop_all
      ;;
    7)
      tail_system_log
      read -r -p "Enter — в меню... "
      ;;
    8)
      say "Качаю Lavalink.jar..."
      "${PY}" scripts/fetch_lavalink.py || err "fetch_lavalink.py завершился с ошибкой."
      say "Качаю JAR-плагины Lavalink (обход Git LFS pointer)..."
      "${PY}" scripts/fetch_lavalink_plugins.py --config "${LL_DIR}/application.yml" --latest-youtube \
        || err "fetch_lavalink_plugins.py завершился с ошибкой."
      ;;
    9)
      run_preflight || err "Preflight failed."
      read -r -p "Enter — в меню... "
      ;;
    0)
      say "Увидимся, босс."
      exit 0
      ;;
    *)
      warn "Такого пункта нет."
      ;;
  esac
done
