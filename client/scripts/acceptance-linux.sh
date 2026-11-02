#!/usr/bin/env bash
# Build and launch the Linux desktop client, then print the manual acceptance
# checklist for PLAN §3b.11 steps 5–8. Does not edit settings, train a model,
# publish a release, or mark those steps done.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$CLIENT/.." && pwd)"

MODE="release"
CHECK_ONLY=0
NO_LAUNCH=0
DO_UPDATER=0
DO_UPDATER_APPIMAGE=0
FRESH=0
UPDATER_STATUS=0

usage() {
  cat <<'EOF'
Ручная приёмка desktop-клиента на Linux (CachyOS / KDE Wayland).

Из корня репозитория:

  bash client/scripts/acceptance-linux.sh

Проверяет пакеты, сессию, масштаб экранов и файлы wake word, собирает AppImage,
печатает чеклист шагов 5–8 и запускает клиент. Шаги в PLAN не закрывает.

  --release            AppImage (это режим по умолчанию)
  --dev                npm run tauri dev, без AppImage
  --check-only         только проверки и чеклист, без сборки и запуска
  --no-launch          собрать, но не запускать
  --fresh              заново выполнить npm ci
  --updater            локальный тест N→N+1 на 127.0.0.1 (без GitHub)
  --updater-appimage   ещё и AppImage, подписанный тестовым ключом
  --self-test          проверка разбора масштаба и wakeword.json
  -h, --help

Чеклист сохраняется в ~/.local/state/neyra/acceptance-checklist.txt
Подробности: client/docs/ACCEPTANCE-LINUX.md
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

version_ge() {
  # $1 >= $2. Numeric dotted parts only; a pre-release suffix is ignored.
  local a="${1%%-*}" b="${2%%-*}"
  local -a aa=() bb=()
  local i n x y
  IFS=. read -r -a aa <<<"$a"
  IFS=. read -r -a bb <<<"$b"
  n=${#aa[@]}
  if ((${#bb[@]} > n)); then
    n=${#bb[@]}
  fi
  for ((i = 0; i < n; i++)); do
    x="${aa[i]:-0}"
    y="${bb[i]:-0}"
    x="${x//[^0-9]/}"
    y="${y//[^0-9]/}"
    [[ -z "$x" ]] && x=0
    [[ -z "$y" ]] && y=0
    if ((10#$x > 10#$y)); then
      return 0
    fi
    if ((10#$x < 10#$y)); then
      return 1
    fi
  done
  return 0
}

parse_kscreen() {
  awk '
    /^Output:/ {
      name = $0
      sub(/^Output:[[:space:]]*[0-9]+[[:space:]]+/, "", name)
      sub(/[[:space:]].*/, "", name)
    }
    /^[[:space:]]*[Ss]cale:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]*[Ss]cale:[[:space:]]*/, "", line)
      split(line, parts, /[[:space:]]+/)
      scale = parts[1]
      sub(/x.*/, "", scale)
      if (name == "") name = "output"
      printf "%s\t%s\n", name, scale
    }
  '
}

parse_wlr() {
  awk '
    /^[^[:space:]#]/ { name = $1 }
    /^[[:space:]]*[Ss]cale:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]*[Ss]cale:[[:space:]]*/, "", line)
      split(line, parts, /[[:space:]]+/)
      scale = parts[1]
      sub(/x.*/, "", scale)
      if (name == "") name = "output"
      printf "%s\t%s\n", name, scale
    }
  '
}

parse_xrandr() {
  awk '
    /^[^[:space:]]+ connected/ { name = $1 }
    /^[[:space:]]*[Ss]cale:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]*[Ss]cale:[[:space:]]*/, "", line)
      split(line, parts, /[[:space:]]+/)
      scale = parts[1]
      sub(/x.*/, "", scale)
      if (name == "") name = "output"
      printf "%s\t%s\n", name, scale
    }
  '
}

summarize_scales() {
  # stdin: name<TAB>scale
  awk -F '\t' '
    function near(value, target) { return (value > target - 0.02 && value < target + 0.02) }
    NF >= 2 && $2 ~ /^[0-9.]+$/ {
      count++
      percent = int($2 * 100 + 0.5)
      printf "  %s  scale %s  (%d%%)\n", $1, $2, percent
      if (near($2 + 0, 1.25)) hit125 = hit125 $1 " "
      if (near($2 + 0, 1.50)) hit150 = hit150 $1 " "
    }
    END {
      if (count == 0) print "Мониторы: масштаб не разобран."
      else printf "Мониторов: %d\n", count
      if (hit125 != "") printf "Сейчас 125%%: %s\n", hit125
      else print "Сейчас 125%: нет."
      if (hit150 != "") printf "Сейчас 150%%: %s\n", hit150
      else print "Сейчас 150%: нет."
      if (count >= 2) print "Несколько мониторов: да."
      else print "Несколько мониторов: нет (сейчас меньше двух выходов)."
    }
  '
}

check_wake_dir() {
  local dir="$1"
  node - "$dir" <<'JS'
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const max = 16 * 1024 * 1024;
const english = ['alexa', 'hey_jarvis', 'hey_mycroft', 'hey_rhasspy', 'timer', 'weather'];
const problems = [];
const manifestPath = path.join(dir, 'wakeword.json');
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  problems.push(error && error.code === 'ENOENT' ? 'Нет wakeword.json' : 'wakeword.json повреждён');
}
if (manifest && (typeof manifest !== 'object' || Array.isArray(manifest))) {
  problems.push('wakeword.json повреждён');
  manifest = null;
}
if (manifest) {
  const allowed = new Set(['schema_version', 'phrase', 'language', 'model', 'license', 'source']);
  for (const key of Object.keys(manifest)) {
    if (!allowed.has(key)) problems.push('wakeword.json повреждён: лишнее поле ' + key);
  }
  const model = typeof manifest.model === 'string' ? manifest.model : '';
  const name = model.toLowerCase();
  const phrase = typeof manifest.phrase === 'string' ? manifest.phrase.trim().toLowerCase() : '';
  const shapeOk = manifest.schema_version === 1
    && phrase === 'нейра'
    && manifest.language === 'ru'
    && path.basename(model) === model
    && name.endsWith('.onnx')
    && name !== 'melspectrogram.onnx'
    && name !== 'embedding_model.onnx';
  if (!shapeOk) problems.push('wakeword.json: нужна русская модель «Нейра» (phrase, language, model)');
  else if (english.some((prefix) => name.startsWith(prefix))) problems.push('Это английская модель openWakeWord, она не распознаёт «Нейра»');
  const license = typeof manifest.license === 'string' ? manifest.license.trim() : '';
  const source = typeof manifest.source === 'string' ? manifest.source.trim() : '';
  if (!license || !source) problems.push('wakeword.json: укажите license и source модели');
}
function checkFile(name) {
  if (!name || path.basename(name) !== name) return;
  const full = path.join(dir, name);
  let info;
  try {
    info = fs.statSync(full);
  } catch {
    problems.push('Нет файла ' + name);
    return;
  }
  if (!info.isFile()) problems.push('Нет файла ' + name);
  else if (info.size === 0) problems.push('Пустой файл ' + name);
  else if (info.size > max) problems.push('Слишком большой файл ' + name);
}
checkFile('melspectrogram.onnx');
checkFile('embedding_model.onnx');
if (manifest && typeof manifest.model === 'string') checkFile(manifest.model);
if (problems.length) {
  process.stdout.write('NOT_READY\n' + [...new Set(problems)].join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('READY\n' + manifest.model + '\n' + manifest.license.trim() + '\n' + manifest.source.trim() + '\n');
JS
}

documents_dir() {
  local file="${XDG_CONFIG_HOME:-$HOME/.config}/user-dirs.dirs"
  local line="" value=""
  if [[ -f "$file" ]]; then
    line="$(grep -E '^XDG_DOCUMENTS_DIR=' "$file" | head -n 1 || true)"
    if [[ -n "$line" ]]; then
      value="${line#XDG_DOCUMENTS_DIR=}"
      value="${value#\"}"
      value="${value%\"}"
      value="${value//\$HOME/${HOME:-}}"
      if [[ -n "$value" && -d "$value" ]]; then
        printf '%s' "$value"
        return 0
      fi
      return 1
    fi
  fi
  if [[ -n "${HOME:-}" && -d "$HOME/Documents" ]]; then
    printf '%s' "$HOME/Documents"
    return 0
  fi
  return 1
}

node_ok() {
  local major="$1" minor="$2"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  if [[ "$major" -ge 23 ]]; then
    return 0
  fi
  if [[ "$major" -eq 22 && "$minor" -ge 12 ]]; then
    return 0
  fi
  if [[ "$major" -eq 20 && "$minor" -ge 19 ]]; then
    return 0
  fi
  return 1
}

resolve_data_root() {
  local cfg="${XDG_CONFIG_HOME:-${HOME:-}/.config}/neyra/data-location.json"
  local chosen="" docs=""
  if [[ -f "$cfg" ]] && command -v node >/dev/null 2>&1; then
    chosen="$(node - "$cfg" <<'JS'
const fs = require('fs');
try {
  const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const root = data && data.data_root;
  if (typeof root === 'string' && root.startsWith('/') && fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    process.stdout.write(root);
  }
} catch { /* pointer is optional */ }
JS
)"
    if [[ -n "$chosen" ]]; then
      printf '%s' "$chosen"
      return 0
    fi
  fi
  if docs="$(documents_dir)"; then
    printf '%s' "$docs/Neyra"
    return 0
  fi
  printf '%s' "${XDG_DATA_HOME:-${HOME:-}/.local/share}/neyra"
}

is_arch() {
  [[ -f /etc/os-release ]] || return 1
  grep -Eq '^(ID|ID_LIKE)=.*(arch|cachyos)' /etc/os-release
}

have_display() {
  [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]
}

session_kind() {
  if [[ "${XDG_SESSION_TYPE:-}" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]]; then
    printf 'wayland'
  elif [[ -n "${DISPLAY:-}" ]]; then
    printf 'x11'
  else
    printf 'none'
  fi
}

fuse2_present() {
  if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    return 0
  fi
  [[ -e /usr/lib/libfuse.so.2 || -e /usr/lib64/libfuse.so.2 || -e /lib/x86_64-linux-gnu/libfuse.so.2 ]]
}

run_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 3 "$@"
  else
    "$@"
  fi
}

bus_name_up() {
  command -v busctl >/dev/null 2>&1 || return 1
  run_timeout busctl --user status "$1" >/dev/null 2>&1
}

dedupe_args() {
  local -A seen=()
  local item
  for item in "$@"; do
    [[ -n "$item" ]] || continue
    [[ -n "${seen[$item]:-}" ]] && continue
    seen[$item]=1
    printf '%s\n' "$item"
  done
}

self_test() {
  local out tmp ready
  out="$(printf '%s\n' 'Output: 1 eDP-1' $'\tScale: 1.25' 'Output: 2 HDMI-A-1' '	Scale: 1.5' | parse_kscreen)"
  [[ "$out" == $'eDP-1\t1.25\nHDMI-A-1\t1.5' ]] || die "kscreen parser: [$out]"
  out="$(printf '%s\n' 'HDMI-A-1 "LG"' '  Scale: 1.500000' 'eDP-1 "BOE"' '  Scale: 1' | parse_wlr)"
  [[ "$out" == $'HDMI-A-1\t1.500000\neDP-1\t1' ]] || die "wlr parser: [$out]"
  out="$(printf '%s\n' 'eDP-1 connected primary 1920x1080+0+0' '	Scale: 1.25x1.25' | parse_xrandr)"
  [[ "$out" == $'eDP-1\t1.25' ]] || die "xrandr parser: [$out]"
  out="$(printf '%s\n' $'eDP-1\t1.25' $'HDMI-A-1\t1.5' | summarize_scales)"
  grep -q 'Мониторов: 2' <<<"$out" || die "summary count: $out"
  grep -q 'Сейчас 125%: eDP-1' <<<"$out" || die "summary 125: $out"
  grep -q 'Сейчас 150%: HDMI-A-1' <<<"$out" || die "summary 150: $out"
  grep -q 'Несколько мониторов: да' <<<"$out" || die "summary multi: $out"
  version_ge '1.91.0' '1.91.0' || die 'version_ge equal'
  version_ge '1.92.1' '1.91.0' || die 'version_ge newer'
  version_ge '1.90.0' '1.91.0' && die 'version_ge older should fail'
  command -v node >/dev/null 2>&1 || die 'self-test needs node'
  tmp="$(mktemp -d)"
  printf 'x' >"$tmp/melspectrogram.onnx"
  printf 'x' >"$tmp/embedding_model.onnx"
  printf 'x' >"$tmp/neyra_v1.onnx"
  printf '%s\n' '{"schema_version":1,"phrase":"Нейра","language":"ru","model":"neyra_v1.onnx","license":"Apache-2.0","source":"own synthetic training"}' >"$tmp/wakeword.json"
  ready="$(check_wake_dir "$tmp")" || die "valid wake model rejected: $ready"
  [[ "$ready" == READY* ]] || die "valid wake model: $ready"
  printf '%s\n' '{"schema_version":1,"phrase":"Нейра","language":"ru","model":"hey_jarvis_v0.1.onnx","license":"CC","source":"oww"}' >"$tmp/wakeword.json"
  printf 'x' >"$tmp/hey_jarvis_v0.1.onnx"
  if ready="$(check_wake_dir "$tmp")"; then
    die "english model was accepted: $ready"
  fi
  grep -q 'английская модель' <<<"$ready" || die "english message: $ready"
  rm -rf "$tmp"
  node_ok 20 19 || die 'node 20.19 should pass'
  node_ok 20 18 && die 'node 20.18 should fail'
  node_ok 21 0 && die 'node 21.0 should fail'
  node_ok 22 12 || die 'node 22.12 should pass'
  node_ok 22 11 && die 'node 22.11 should fail'
  node_ok 23 0 || die 'node 23.0 should pass'
  root_tmp="$(mktemp -d)"
  (
    export HOME="$root_tmp/home"
    export XDG_CONFIG_HOME="$root_tmp/config"
    export XDG_DATA_HOME="$root_tmp/data"
    mkdir -p "$HOME/Documents" "$XDG_CONFIG_HOME"
    printf 'XDG_DOCUMENTS_DIR="%s"\n' "$root_tmp/missing-docs" >"$XDG_CONFIG_HOME/user-dirs.dirs"
    got="$(resolve_data_root)"
    [[ "$got" == "$XDG_DATA_HOME/neyra" ]] || die "set-but-missing documents should be data home, got $got"
    printf '# unset\n' >"$XDG_CONFIG_HOME/user-dirs.dirs"
    got="$(resolve_data_root)"
    [[ "$got" == "$HOME/Documents/Neyra" ]] || die "unset documents var should use ~/Documents, got $got"
    mkdir -p "$XDG_CONFIG_HOME/neyra" "$root_tmp/chosen"
    printf '{"data_root":"%s"}\n' "$root_tmp/chosen" >"$XDG_CONFIG_HOME/neyra/data-location.json"
    printf 'XDG_DOCUMENTS_DIR="%s"\n' "$root_tmp/missing-docs" >"$XDG_CONFIG_HOME/user-dirs.dirs"
    got="$(resolve_data_root)"
    [[ "$got" == "$root_tmp/chosen" ]] || die "pointer should win, got $got"
  )
  rm -rf "$root_tmp"
  printf 'self-test ok\n'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) MODE="release" ;;
    --dev) MODE="dev" ;;
    --check-only) CHECK_ONLY=1 ;;
    --no-launch) NO_LAUNCH=1 ;;
    --fresh) FRESH=1 ;;
    --updater) DO_UPDATER=1 ;;
    --updater-appimage) DO_UPDATER=1; DO_UPDATER_APPIMAGE=1 ;;
    --self-test) self_test; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный аргумент: $1 (bash client/scripts/acceptance-linux.sh --help)" ;;
  esac
  shift
done

if [[ "$(id -u)" -eq 0 ]]; then
  die "Запускайте скрипт своим пользователем, не root. Иначе папка данных и keyring будут чужие."
fi
if [[ "$CHECK_ONLY" -eq 1 && "$DO_UPDATER_APPIMAGE" -eq 1 ]]; then
  die "--updater-appimage собирает AppImage, вместе с --check-only его не запускают."
fi

missing_pacman=()
missing_apt=()
missing_required=0
node_note=""
rust_note=""

require_cmd() {
  local cmd="$1" arch="$2" deb="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf 'ok   %s\n' "$cmd"
  else
    printf 'нет  %s\n' "$cmd"
    missing_pacman+=("$arch")
    missing_apt+=("$deb")
    missing_required=1
  fi
}

require_pc() {
  local pc="$1" arch="$2" deb="$3"
  if pkg-config --exists "$pc" 2>/dev/null; then
    printf 'ok   %s\n' "$pc"
  else
    printf 'нет  %s\n' "$pc"
    missing_pacman+=("$arch")
    missing_apt+=("$deb")
    missing_required=1
  fi
}

check_deps() {
  printf '\n== Зависимости сборки ==\n'
  require_cmd gcc base-devel build-essential
  require_cmd make base-devel build-essential
  require_cmd pkg-config pkgconf pkg-config
  require_cmd curl curl curl
  require_cmd wget wget wget
  require_cmd file file file
  require_cmd patchelf patchelf patchelf
  if command -v pkg-config >/dev/null 2>&1; then
    require_pc webkit2gtk-4.1 webkit2gtk-4.1 libwebkit2gtk-4.1-dev
    require_pc gtk+-3.0 gtk3 libgtk-3-dev
    require_pc librsvg-2.0 librsvg librsvg2-dev
    require_pc alsa alsa-lib libasound2-dev
    require_pc dbus-1 dbus libdbus-1-dev
    if pkg-config --exists ayatana-appindicator3-0.1 2>/dev/null || pkg-config --exists appindicator3-0.1 2>/dev/null; then
      printf 'ok   appindicator\n'
    else
      printf 'нет  appindicator (ayatana-appindicator3-0.1 или appindicator3-0.1)\n'
      missing_pacman+=(libappindicator-gtk3)
      missing_apt+=(libappindicator3-dev)
      missing_required=1
    fi
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf 'нет  node/npm (нужен Node 20.19+, 22.12+ или 23+; CI ставит 22)\n'
    missing_pacman+=(nodejs npm)
    missing_apt+=(nodejs npm)
    missing_required=1
  else
    local major minor
    major="$(node -p 'process.versions.node.split(".")[0]')"
    minor="$(node -p 'process.versions.node.split(".")[1]')"
    printf 'ok   node %s\n' "$(node -v)"
    if node_ok "$major" "$minor"; then
      if [[ "$major" -ne 22 ]]; then
        node_note="Сейчас $(node -v). CI собирает Node 22. Если сборка упадёт на версии Node: paru -S nodejs-lts-jod (AUR) или nvm install 22."
      fi
    else
      node_note="Node $(node -v) для Vite 7 не подходит. Нужен 20.19+, 22.12+ или 23+ (21 не годится). CI ставит Node 22. На CachyOS: paru -S nodejs-lts-jod (AUR), либо nvm."
      missing_required=1
    fi
  fi

  if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
    printf 'нет  rustc/cargo (нужен stable >= 1.91)\n'
    missing_pacman+=(rustup)
    missing_apt+=(cargo)
    missing_required=1
    rust_note="После установки: rustup default stable"
  else
    local rustv
    rustv="$(rustc --version | awk '{print $2}')"
    printf 'ok   rustc %s\n' "$rustv"
    if ! version_ge "$rustv" "1.91.0"; then
      missing_required=1
      if command -v rustup >/dev/null 2>&1; then
        rust_note="rustc $rustv старше 1.91. Выполните: rustup update stable"
      else
        rust_note="rustc $rustv старше 1.91. Поставьте rustup и уберите старый rust из pacman, если он перекрывает rustup: sudo pacman -S --needed rustup && rustup default stable"
      fi
    fi
  fi

  if [[ -n "$node_note" ]]; then printf '%s\n' "$node_note"; fi
  if [[ -n "$rust_note" ]]; then printf '%s\n' "$rust_note"; fi

  if [[ "$missing_required" -eq 1 ]]; then
    printf '\nСборка не начата: не хватает пакетов или версий.\n'
    local pacman_line apt_line
    pacman_line="$(dedupe_args "${missing_pacman[@]}" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    apt_line="$(dedupe_args "${missing_apt[@]}" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    if [[ -n "$pacman_line" ]]; then
      printf '\nCachyOS / Arch:\n  sudo pacman -S --needed %s\n' "$pacman_line"
      if [[ "$pacman_line" == *rustup* ]]; then
        printf '  rustup default stable\n'
      fi
    fi
    if ! is_arch && [[ -n "$apt_line" ]]; then
      printf '\nЭта машина не Arch. Debian/Ubuntu:\n  sudo apt-get update && sudo apt-get install -y %s\n' "$apt_line"
    fi
    return 1
  fi
  printf 'Обязательные зависимости на месте.\n'
}

probe_environment() {
  local kind desktop docs_note=""
  kind="$(session_kind)"
  desktop="${XDG_CURRENT_DESKTOP:-${XDG_SESSION_DESKTOP:-}}"
  SESSION_TEXT="$(
    printf 'Сессия: %s\n' "$kind"
    printf 'XDG_SESSION_TYPE=%s\n' "${XDG_SESSION_TYPE:-}"
    printf 'XDG_CURRENT_DESKTOP=%s\n' "${XDG_CURRENT_DESKTOP:-}"
    printf 'WAYLAND_DISPLAY=%s\n' "${WAYLAND_DISPLAY:-}"
    printf 'DISPLAY=%s\n' "${DISPLAY:-}"
  )"
  if [[ "$kind" == "wayland" ]]; then
    HOTKEY_TEXT="Глобальные хоткеи на Wayland не регистрируются. Push-to-talk и Stop — кнопки в окне."
  elif [[ "$kind" == "x11" ]]; then
    HOTKEY_TEXT="На X11, если регистрация прошла: удержание Ctrl+Alt+Space — запись, Ctrl+Alt+Escape — Stop. Иначе те же кнопки."
  else
    HOTKEY_TEXT="Нет WAYLAND_DISPLAY и DISPLAY. Окно клиента здесь не откроется."
  fi

  if [[ "$desktop" == *[Kk][Dd][Ee]* || "$desktop" == *[Pp]lasma* ]]; then
    OVERLAY_EXPECT="Ожидание для KDE Wayland по коду клиента: прозрачность да, поверх окон не гарантировано, клики сквозь окно да, скрытие со скриншотов нет. Правило KWin для заголовка «Neyra character»: держать поверх других."
  elif [[ "$kind" == "wayland" ]]; then
    OVERLAY_EXPECT="Ожидание для Wayland не-KDE: поверх окон не гарантировано. Для оверлея в настройках графики есть режим X11 (XWayland)."
  elif [[ "$kind" == "x11" ]]; then
    OVERLAY_EXPECT="Ожидание для X11: прозрачность, поверх окон и click-through да, если работает композитор. Со скриншотов окно не скрывается."
  else
    OVERLAY_EXPECT="Сессия не определена, ожидаемое поведение оверлея неизвестно."
  fi

  NVIDIA_TEXT="NVIDIA: nvidia-smi не найден."
  if command -v nvidia-smi >/dev/null 2>&1; then
    local gpu
    gpu="$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -n 3 || true)"
    if [[ -n "$gpu" ]]; then
      NVIDIA_TEXT="NVIDIA: $gpu"
      if [[ "$kind" == "wayland" ]]; then
        NVIDIA_TEXT="$NVIDIA_TEXT
Если окно серое или пустое: Настройки → Графика Linux → «Wayland · NVIDIA explicit sync workaround», затем полный перезапуск. Режим «Совместимость» включает WEBKIT_DISABLE_DMABUF_RENDERER=1 и может замедлить UI."
      fi
    fi
  elif [[ -r /proc/driver/nvidia/version ]]; then
    NVIDIA_TEXT="NVIDIA: $(head -n 1 /proc/driver/nvidia/version)"
  fi

  SCALE_TEXT=""
  local parsed="" tool=""
  if command -v kscreen-doctor >/dev/null 2>&1; then
    parsed="$(kscreen-doctor -o 2>/dev/null | parse_kscreen || true)"
    tool="kscreen-doctor -o"
  fi
  if [[ -z "$parsed" ]] && command -v wlr-randr >/dev/null 2>&1; then
    parsed="$(wlr-randr 2>/dev/null | parse_wlr || true)"
    tool="wlr-randr"
  fi
  if [[ -z "$parsed" ]] && command -v swaymsg >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    parsed="$(swaymsg -t get_outputs -r 2>/dev/null | node -e '
      let raw = "";
      process.stdin.on("data", (c) => { raw += c; });
      process.stdin.on("end", () => {
        try {
          const outputs = JSON.parse(raw);
          for (const output of outputs) {
            if (output && output.name && typeof output.scale === "number") {
              process.stdout.write(output.name + "\t" + output.scale + "\n");
            }
          }
        } catch { /* not sway */ }
      });
    ' || true)"
    tool="swaymsg -t get_outputs"
  fi
  if [[ -z "$parsed" ]] && command -v xrandr >/dev/null 2>&1; then
    parsed="$(xrandr --verbose 2>/dev/null | parse_xrandr || true)"
    tool="xrandr --verbose"
  fi
  if [[ -n "$parsed" ]]; then
    SCALE_TEXT="$(printf 'Источник масштаба: %s\n%s\n%s\n' "$tool" "$parsed" "$(printf '%s\n' "$parsed" | summarize_scales)")"
  else
    SCALE_TEXT="Масштаб экранов не прочитан (нет вывода kscreen-doctor, wlr-randr, swaymsg или xrandr).
CachyOS / KDE: sudo pacman -S --needed libkscreen
X11: sudo pacman -S --needed xorg-xrandr
wlroots: sudo pacman -S --needed wlr-randr"
  fi

  if bus_name_up org.freedesktop.portal.Desktop; then
    PORTAL_TEXT="Портал org.freedesktop.portal.Desktop на сессионной шине есть. Первый снимок и ввод покажут запрос разрешения."
  else
    PORTAL_TEXT="Портал org.freedesktop.portal.Desktop не ответил. Контур 4 на Wayland без него не заработает.
CachyOS / KDE: sudo pacman -S --needed xdg-desktop-portal xdg-desktop-portal-kde"
  fi

  if bus_name_up org.freedesktop.secrets; then
    SECRET_TEXT="Secret Service (org.freedesktop.secrets) есть. Токен можно сохранить в keyring."
  else
    SECRET_TEXT="Secret Service не ответил. Токен не сохранится: у KWallet должен быть включён интерфейс Secret Service.
Пакет, если кошелька нет: sudo pacman -S --needed kwallet"
  fi

  if fuse2_present; then
    FUSE_TEXT="FUSE 2 (libfuse.so.2) есть. AppImage можно запускать как есть."
  else
    FUSE_TEXT="FUSE 2 нет. Запуск будет с APPIMAGE_EXTRACT_AND_RUN=1.
Чтобы запускать обычным способом: sudo pacman -S --needed fuse2"
  fi

  local optional=()
  command -v playerctl >/dev/null 2>&1 || optional+=(playerctl)
  command -v pactl >/dev/null 2>&1 || optional+=(libpulse)
  if [[ "$kind" == "x11" ]] && ! command -v wmctrl >/dev/null 2>&1; then
    optional+=(wmctrl)
  fi
  if [[ ${#optional[@]} -eq 0 ]]; then
    OPTIONAL_TEXT="Дополнительно для медиа/окон: нужные команды на месте (playerctl, pactl, на X11 ещё wmctrl)."
  else
    OPTIONAL_TEXT="Необязательно, сборку не блокирует. Без них часть контуров просто не объявится:
  sudo pacman -S --needed ${optional[*]}"
  fi

  DATA_ROOT="$(resolve_data_root)"
  LOG_PATH="$DATA_ROOT/logs/client.log"
  WAKE_DIR="$DATA_ROOT/wakeword"
  GRAPHICS_TEXT="graphics_mode: файл настроек ещё не читался."
  CHARACTER_TEXT="character_enabled: неизвестно, пока нет settings/app.json."
  if [[ -f "$DATA_ROOT/settings/app.json" ]] && command -v node >/dev/null 2>&1; then
    local bits
    bits="$(node - "$DATA_ROOT/settings/app.json" <<'JS'
const fs = require('fs');
try {
  const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const mode = typeof data.graphics_mode === 'string' ? data.graphics_mode : 'auto';
  const enabled = data.character_enabled === true ? 'true' : 'false';
  process.stdout.write(mode + '\n' + enabled + '\n');
} catch {
  process.stdout.write('unreadable\nfalse\n');
}
JS
)"
    GRAPHICS_TEXT="graphics_mode в settings/app.json: $(printf '%s\n' "$bits" | head -n 1)"
    CHARACTER_TEXT="character_enabled в settings/app.json: $(printf '%s\n' "$bits" | sed -n '2p')"
  elif [[ ! -d "$DATA_ROOT" ]]; then
    docs_note="Папка данных появится при первом запуске."
  fi

  WAKE_TEXT="Папка wake word: $WAKE_DIR"
  if [[ ! -d "$WAKE_DIR" ]]; then
    WAKE_TEXT="$WAKE_TEXT
Папки нет. Модель в git не лежит. $docs_note
Нужны melspectrogram.onnx, embedding_model.onnx, свой классификатор и wakeword.json.
Клипы для обучения, без записи голоса: server/scripts/wakeword_synth_dataset.py (это серверный TTS и .env сервера; скрипт приёмки его не запускает)."
  elif ! command -v node >/dev/null 2>&1; then
    WAKE_TEXT="$WAKE_TEXT
node ещё нет, JSON не проверен. После установки Node запустите скрипт с --check-only."
  else
    local report
    if report="$(check_wake_dir "$WAKE_DIR")"; then
      WAKE_TEXT="$WAKE_TEXT
Файлы и wakeword.json сходятся с правилами клиента.
$(printf '%s\n' "$report" | sed -n '2,4p')
Кнопка «Проверить модель» на вкладке «Голос» отдельно грузит граф. Срабатывание на микрофоне этот скрипт не проверяет."
    else
      WAKE_TEXT="$WAKE_TEXT
Модель не готова:
$(printf '%s\n' "$report" | sed '1d')"
    fi
  fi
}

print_checklist() {
  cat <<EOF
== Чеклист приёмки шагов 5–8 ==

Это подсказка для прогона на вашем ПК. Скрипт шаги не закрывает и в PLAN ничего не пишет.
Автоматические строки ниже — снимок этой сессии, не отметка «принято».

Папка данных: $DATA_ROOT
Лог клиента: $LOG_PATH
Ротация: client.log.1 … client.log.3 (порог 256 КБ, в логе нет токенов и звука).
Повторный снимок окружения без сборки:
  bash client/scripts/acceptance-linux.sh --check-only
Копия этого текста: $CHECKLIST_PATH

$SESSION_TEXT
$HOTKEY_TEXT
$NVIDIA_TEXT
$GRAPHICS_TEXT
$SCALE_TEXT
$PORTAL_TEXT
$SECRET_TEXT
$FUSE_TEXT
$OPTIONAL_TEXT

-- Шаг 5. Wake word «Нейра», live voice, half-duplex, barge-in --

$WAKE_TEXT

Смотреть в окне: вкладка «Голос».
1. «Проверить модель». Строка «Модель готова» должна назвать ваш onnx и лицензию. «Модель не готова» — смотрите текст и папку выше.
2. Режим «Слово «Нейра» и команда», «Начать разговор». Скажите «Нейра» и короткую команду. До слова «Нейра» статус не должен уйти в отправку фразы; после слова клиент пишет, что звук до этого остаётся на ПК.
3. Режим «Слушать всегда»: фраза после паузы 0,5–1,5 с уходит на сервер, ответ приходит голосом.
4. «Перебивать Нейру голосом» = «Нет»: пока Нейра говорит через колонки, индикатор микрофона молчит. Это half-duplex, не эхоподавление. AEC в клиенте нет.
5. Тот же пункт = «Да, я в наушниках»: речь поверх ответа Нейры обрывает текущую озвучку. Через колонки так делать не нужно: она услышит сама себя.
6. Кнопка Stop или пункт трея выключает живой микрофон.

Логи: терминал, из которого запущен этот скрипт (ошибки WebKit и портала), плюс $LOG_PATH.
STT/TTS и конверсия голоса — на сервере, не в этом логе. На машине сервера: journalctl -u neyra -n 100 --no-pager, либо терминал, где запущен сервер. Конверсия RVC на MiniPC этим скриптом не проверяется.

-- Шаг 6. DPI 125% и 150%, несколько мониторов, KDE Wayland --

Скрипт только читает текущий масштаб. Смените его в Параметрах системы → Экран и монитор, оставьте два выхода, затем снова:
  bash client/scripts/acceptance-linux.sh --check-only
Нужны оба значения: 125% и 150%, и строка «Несколько мониторов: да». Один прогон с одним масштабом второй масштаб не закрывает.

В клиенте: «Доступ к ПК» → включить управление ПК, затем «Снимки экрана» и «Мышь и клавиатура». На Wayland первый вызов открывает диалог портала. Разрешите экран и ввод.
Проверка координат: окно-мишень на втором мониторе и у стыка мониторов. Клик Нейры должен попасть в это окно, а не в сдвинутую точку основного. Повторите на 125% и на 150%. Свои окна Neyra на время снимка скрываются.
Если на вкладке написано, что экран в этой сессии недоступен, шаг не пройден: смотрите строку портала выше и
  journalctl --user -b -n 200 --no-pager | grep -i portal
$HOTKEY_TEXT
Окна на чистом Wayland клиент не объявляет. wmctrl относится только к X11.

-- Шаг 7. Оверлей персонажа на Wayland. Windows этот скрипт не покрывает --

$CHARACTER_TEXT
$OVERLAY_EXPECT

Галочка «Персонаж на рабочем столе» в разделе «Настройки» сохраняется сразу. Перезапуск не нужен, файл settings/app.json руками не правьте.
1. Включите её.
2. Откройте «Персонаж» и нажмите «Показать окно».
Заголовок окна: «Neyra character». На KDE правило KWin для этого заголовка — «держать поверх».
Сверьте четыре строки возможностей в панели с ожиданием выше. Дальше руками: прозрачный фон, клики сквозь окно, окно остаётся на месте при переключении программ.
Свой .vrm положите в папку, которую показывает панель (подкаталог character). Синтетический файл для дымовой проверки окна, не модель для защиты: client/tests/fixtures/neyra-test.vrm. Его лицензия в комментарии генератора, в сборку он не входит.
Windows (прозрачность, always-on-top, click-through, скрытие со скриншотов) примите отдельно на Windows. Этот скрипт туда не смотрит.

-- Шаг 8. Обновление N→N+1 --

Локальный тест, если вы запустили скрипт с --updater: cargo test --locked --test updater_chain
в client/src-tauri. Он поднимает HTTP на 127.0.0.1 и ставит 0.1.1 поверх макета 0.1.0 тестовым ключом.
Флаг --updater-appimage дополнительно подписывает настоящий AppImage тем же тестовым ключом и гоняет игнорируемый тест. Это проверка плагина, не кнопка в установленном приложении.

Кнопка «Настройки → Обновления» ходит только на GitHub:
  бета  https://github.com/ebluffy/Neyra-AIAssist/releases/download/client-beta/latest.json
  стабильный  https://github.com/ebluffy/Neyra-AIAssist/releases/latest/download/latest.json
Черновик релиза по этим адресам не отдаётся. Публичный ключ в tauri.conf.json — заготовка (minisign id 1AAFC11FB991FBB6), приватной половины в репозитории нет. Тестовый ключ client/src-tauri/updater-test/test.key в этот конфиг подставлять нельзя.
Пока нет своего ключа и опубликованного latest.json, «Проверить обновления» не является прогоном N→N+1. Ожидаемый исход сейчас: сетевая ошибка или «Установлена последняя версия».

Настоящий draft, когда решите выпускать (из этого скрипта ничего не публикуется):
1. Вне git: cd client && npm run tauri -- signer generate -w "\$HOME/neyra-updater.key"
   Файл ключа не коммитить.
2. Текст .pub записать в client/src-tauri/tauri.conf.json → plugins.updater.pubkey и закоммитить только публичную половину.
3. Секреты GitHub: TAURI_SIGNING_PRIVATE_KEY и TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
   Пока их нет, .github/workflows/client-release.yml останавливается на preflight и релиз не собирает.
4. Поднять одну версию в package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml и src-tauri/Cargo.lock (пакет neyra-client). Проверка: cd client && npm run check:versions
5. Тег client-v<версия> (бета с суффиксом, например client-v0.1.1-beta.1) и push тега, либо ручной запуск workflow «Desktop release (draft)». Workflow создаёт черновик и сам его не публикует.
6. После вашей ручной публикации, для канала «Бета»: gh release upload client-beta latest.json --clobber
   Тег client-beta один раз создаётся как prerelease. Стабильный канал читает только опубликованный GitHub latest, не prerelease и не draft.
7. На ПК AppImage версии N лежит в каталоге, куда вы можете писать (например ~/Applications). Настройки → Обновления → проверить → установить → перезапустить.
   Сверить адрес сервера, токен в keyring, тему, разрешения, device id и что файл AppImage по тому же пути заменён.
   Дочерние программы не должны наследовать LD_LIBRARY_PATH AppImage.
8. Windows NSIS и SmartScreen сюда не входят.

Смотреть: панель «Обновления» (версия, канал, текст ошибки), $LOG_PATH, терминал запуска.
EOF
}

run_updater_test() {
  printf '\n== Локальный N→N+1 (без GitHub) ==\n'
  printf 'cargo test --locked --test updater_chain\n'
  set +e
  (cd "$CLIENT/src-tauri" && cargo test --locked --test updater_chain)
  local status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    UPDATER_STATUS=$status
  fi
  if [[ "$UPDATER_STATUS" -eq 0 ]]; then
    printf 'Локальный тест обновления прошёл. Кнопку в приложении это не закрывает.\n'
  else
    printf 'Локальный тест обновления завершился с кодом %s.\n' "$UPDATER_STATUS"
  fi
}

run_updater_appimage() {
  local version appimage
  printf '\n== AppImage с тестовым ключом ==\n'
  printf 'Ключ: client/src-tauri/updater-test/test.key. В tauri.conf.json он не записывается.\n'
  version="$(node -p "require('$CLIENT/package.json').version")"
  (
    cd "$CLIENT"
    TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/updater-test/test.key)"
    export TAURI_SIGNING_PRIVATE_KEY
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
    npm run tauri build -- --config src-tauri/tauri.release.conf.json --bundles appimage
  )
  shopt -s nullglob
  local found=("$CLIENT/src-tauri/target/release/bundle/appimage/Neyra_${version}_amd64.AppImage")
  shopt -u nullglob
  appimage="${found[0]:-}"
  [[ -n "$appimage" && -f "$appimage" && -f "${appimage}.sig" ]] || die "Нет подписанного AppImage для версии $version"
  set +e
  (
    cd "$CLIENT/src-tauri"
    export NEYRA_REAL_APPIMAGE="$appimage"
    export NEYRA_REAL_VERSION="$version"
    cargo test --locked --test updater_chain -- --ignored real_signed_appimage_installs_and_tampering_is_rejected
  )
  local status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    UPDATER_STATUS=$status
    printf 'Тест реального AppImage завершился с кодом %s.\n' "$status"
  fi
}

npm_install() {
  local need=0
  if [[ "$FRESH" -eq 1 || ! -d "$CLIENT/node_modules" ]]; then
    need=1
  elif [[ "$CLIENT/package-lock.json" -nt "$CLIENT/node_modules" ]]; then
    need=1
  fi
  if [[ "$need" -eq 1 ]]; then
    printf '\n== npm ci ==\n'
    (cd "$CLIENT" && npm ci --ignore-scripts)
  else
    printf '\nnode_modules уже есть. Повторная установка: --fresh\n'
  fi
}

build_release() {
  printf '\n== Сборка AppImage ==\n'
  printf 'Первый раз это долго: Rust и загрузка linuxdeploy. Секреты подписи не нужны.\n'
  (cd "$CLIENT" && npm run tauri build -- --bundles appimage)
}

find_appimage() {
  shopt -s nullglob
  local files=("$CLIENT/src-tauri/target/release/bundle/appimage/"*.AppImage)
  shopt -u nullglob
  [[ ${#files[@]} -gt 0 ]] || return 1
  local newest="" file
  for file in "${files[@]}"; do
    if [[ -z "$newest" || "$file" -nt "$newest" ]]; then
      newest="$file"
    fi
  done
  printf '%s' "$newest"
}

launch_release() {
  local appimage=""
  if appimage="$(find_appimage)"; then
    chmod +x "$appimage"
    printf '\nЗапуск: %s\n' "$appimage"
    if fuse2_present; then
      "$appimage"
    else
      APPIMAGE_EXTRACT_AND_RUN=1 "$appimage"
    fi
    return
  fi
  local bin="$CLIENT/src-tauri/target/release/neyra-client"
  if [[ -x "$bin" ]]; then
    printf '\nAppImage нет, запускаю бинарник без упаковки: %s\n' "$bin"
    printf 'Замена файла обновлением проверяется только на AppImage.\n'
    "$bin"
    return
  fi
  die "Сборка не оставила ни AppImage, ни $bin"
}

main() {
  printf 'Neyra acceptance · %s\n' "$ROOT"
  probe_environment
  if ! check_deps; then
    exit 1
  fi
  if [[ "$DO_UPDATER" -eq 1 ]]; then
    run_updater_test
  fi
  if [[ "$CHECK_ONLY" -eq 0 ]]; then
    npm_install
    if [[ "$DO_UPDATER_APPIMAGE" -eq 1 ]]; then
      run_updater_appimage
    elif [[ "$MODE" == "release" ]]; then
      build_release
    fi
  fi

  local state_dir
  if [[ -n "${XDG_STATE_HOME:-}" ]]; then
    state_dir="$XDG_STATE_HOME"
  else
    state_dir="${HOME:-/tmp}/.local/state"
  fi
  CHECKLIST_PATH="$state_dir/neyra/acceptance-checklist.txt"
  mkdir -p "$(dirname "$CHECKLIST_PATH")"
  print_checklist | tee "$CHECKLIST_PATH"
  printf '\nЧеклист записан: %s\n' "$CHECKLIST_PATH"

  if [[ "$CHECK_ONLY" -eq 1 || "$NO_LAUNCH" -eq 1 ]]; then
    exit "$UPDATER_STATUS"
  fi
  if ! have_display; then
    printf 'Дисплея нет (WAYLAND_DISPLAY и DISPLAY пустые). Клиент не запущен.\n'
    exit 2
  fi
  printf '\nДальше окно Neyra. Этот терминал держите открытым: в нём stderr.\n'
  local app_status=0
  set +e
  if [[ "$MODE" == "dev" ]]; then
    printf 'Режим dev: первая компиляция Rust долгая.\n'
    (cd "$CLIENT" && npm run tauri dev)
    app_status=$?
  else
    launch_release
    app_status=$?
  fi
  set -e
  printf 'Клиент завершился с кодом %s.\n' "$app_status"
  if [[ "$UPDATER_STATUS" -ne 0 ]]; then
    exit "$UPDATER_STATUS"
  fi
  exit "$app_status"
}

main
