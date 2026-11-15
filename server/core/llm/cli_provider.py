"""CLI-провайдер OpenCode в настоящей песочнице bwrap.

Запуск возможен только через `bwrap`: без него провайдер отказывает, прямого
fallback нет. Внутри namespaces видны read-only системные каталоги, сам CLI
(read-only), свежий tmpfs вместо HOME на каждый вызов, `/tmp`, `/proc`, `/dev`.
Сеть остаётся (`--share-net`), потому что OpenCode ходит к модели.

Инструменты OpenCode выключены двумя слоями: сгенерированный конфиг
(`tools: false`, `permission: deny` по именам) и плагин на хуке `context`,
который удаляет все инструменты из запроса к модели. Конфиг и плагин
монтируются read-only, переписать их из песочницы нельзя. HOME и cwd — одноразовый tmpfs, поэтому
история сессий, `AGENTS.md` и мусор не переживают вызов. Авторизация
пробрасывается одним файлом read-only внутрь `XDG_DATA_HOME`.

Env потомка — whitelist: PATH/LANG/LC_*/TZ/TERM; HOME/TMPDIR/XDG и
OPENCODE_CONFIG задаёт ядро внутри sandbox. `API_TOKEN`, `NEYRA_*`,
Discord/Deepgram-токены не передаются. Промпт идёт через stdin, не в argv.

Ограничения: нет нативного стриминга (ответ одним куском); brain на CLI не
умеет tools (`bind_tools` бросает понятную ошибку, конфиг с tools отклоняется
на старте); vision на CLI не поддерживается — картинки заменяются
плейсхолдером; `max_tokens` CLI не принимает, ответ обрезается с warning.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Iterator, Optional, Sequence

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

logger = logging.getLogger("neyra.llm_cli")

CLI_KINDS: tuple[str, ...] = ("opencode",)
CLI_BACKENDS: tuple[str, ...] = ("run",)
DEFAULT_TIMEOUT_SECONDS = 120.0
SANDBOX_HOME = "/home/sandbox"
SANDBOX_CONFIG_PATH = f"{SANDBOX_HOME}/config/opencode/opencode.json"
SANDBOX_CONFIG_DIR = f"{SANDBOX_HOME}/config/opencode"
SANDBOX_AUTH_DIR = f"{SANDBOX_HOME}/data/opencode"
SANDBOX_AUTH_PATH = f"{SANDBOX_AUTH_DIR}/auth.json"
SANDBOX_PLUGIN_DIR = f"{SANDBOX_HOME}/plugin"
SANDBOX_STATE_DIR = f"{SANDBOX_HOME}/state"
SANDBOX_DIR_NAME = "cli-sandbox"

# Широкие корни, которые нельзя монтировать в песочницу целиком (AR-68).
_WIDE_ROOTS = {
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/media",
    "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp",
    "/usr", "/var",
}
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_CONCURRENT_CLI = 4
CHARS_PER_TOKEN = 4
IMAGE_PLACEHOLDER = "[изображение не передано: CLI-провайдер не поддерживает зрение]"

# Версии OpenCode, на которых проверено отключение инструментов (AR-75).
VERIFIED_OPENCODE_VERSIONS: frozenset[str] = frozenset({"2.3.0"})

# Модель приходит из конфига и меняется через API: только безопасный набор
# символов, без ведущего дефиса (иначе это флаг OpenCode, а не модель).
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]*$")

# AR-71: у CLI-лейна нет инструментов, и модель не должна их изображать.
CLI_GUARD = (
    "У тебя нет инструментов: ни bash, ни файлов, ни сети. "
    "Не вызывай и не изображай вызовы инструментов; отвечай в том формате, "
    "который требуется в запросе."
)

# Разметка, которой модели изображают вызов инструмента. Ищем структуру
# вызова в любом месте ответа и в любом регистре (AR-85), но JSON-ответы,
# fenced-блоки и inline-код считаются данными (AR-80/87).
TOOL_MARKUP_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"<\s*[|｜]\s*DSML\s*[|｜]",
        r"<\s*(?:function_calls|function_call|tool_calls?)\s*>",
        r"<\s*invoke\s+name\s*=",
        r"<\s*function\s*=",
        r"antml:invoke\s+name\s*=",
    )
)

# Системные каталоги: CLI оттуда не принимается (AR-75), поэтому bind не нужен.
PRE_MOUNTED_ROOTS: tuple[Path, ...] = tuple(
    Path(p) for p in ("/usr", "/bin", "/sbin", "/lib", "/lib64")
)

# Единственный разрешённый каталог рантаймов OpenCode на хосте.
OPENBOT_CONFIG_ROOT = Path("/var/lib/openbot/.config/OpenBot")
RUNTIME_MARKER = "provider-runtimes"

_SENSITIVE_TREES: tuple[str, ...] = (
    "/etc",
    "/root",
    "/home",
    "/opt/neyra",
    "/var/lib/openbot",
)

_OPENCODE_TOOLS: tuple[str, ...] = (
    "bash",
    "edit",
    "multiedit",
    "write",
    "patch",
    "read",
    "grep",
    "glob",
    "list",
    "webfetch",
    "websearch",
    "task",
    "skill",
    "todowrite",
    "todoread",
    "question",
    "lsp",
    # AR-71: Code Mode и встроенные инструменты CLI не перечислены в списке
    # обычных tools, но приходят модели, пока их не выключат по имени.
    "execute",
    "opencode_models",
    "opencode_list_mcp_resources",
    "opencode_read_mcp_resource",
)


class CliProviderError(RuntimeError):
    """CLI не найден, bwrap недоступен, процесс упал или вернул мусор."""


def _is_under(path: Path, parent: Path) -> bool:
    """path == parent или лежит внутри parent (без resolve: пути уже resolved)."""
    return path == parent or parent in path.parents


def _is_opencode_runtime_root(path: Path) -> bool:
    """`.../provider-runtimes/opencode/<platform>/<version>` — каталог версии."""
    parts = path.parts
    for index, part in enumerate(parts):
        if part != RUNTIME_MARKER:
            continue
        if index + 1 >= len(parts) or parts[index + 1] != "opencode":
            continue
        tail = parts[index + 2 :]
        if len(tail) == 2 and all(tail):
            return True
    return False


def _opencode_config_text() -> str:
    """Конфиг OpenCode: все инструменты и разрешения выключены."""
    payload = {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "share": "disabled",
        "tools": {name: False for name in _OPENCODE_TOOLS},
        "permission": {name: "deny" for name in _OPENCODE_TOOLS},
        "plugins": [SANDBOX_PLUGIN_DIR],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


@dataclass(frozen=True)
class CliSettings:
    cli: str
    backend: str
    model: str
    sandbox: str
    cli_path: str
    data_dir: str = ""
    auth_file: str = ""
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    extra_args: tuple[str, ...] = ()
    experimental: bool = False

    @classmethod
    def from_config(
        cls,
        block: dict[str, Any],
        *,
        model: str,
        data_dir: str = "",
        default_sandbox: str = "",
    ) -> "CliSettings":
        cli = str(block.get("cli") or "opencode").strip().lower()
        if cli not in CLI_KINDS:
            raise CliProviderError(f"CLI '{cli}' пока не поддерживается: {', '.join(CLI_KINDS)}")
        backend = str(block.get("backend") or "run").strip().lower()
        if backend not in CLI_BACKENDS:
            raise CliProviderError(f"Бэкенд CLI '{backend}' пока не поддерживается: {', '.join(CLI_BACKENDS)}")
        if block.get("experimental") is not True:
            raise CliProviderError(
                "CLI-провайдер экспериментальный: без явного experimental: true он не включается."
            )
        if not str(data_dir or "").strip():
            raise CliProviderError(
                "CLI-провайдеру нужен paths.data_dir ядра: sandbox разрешён только внутри него"
            )
        data_root = Path(str(data_dir)).expanduser().resolve()
        sandbox = str(block.get("sandbox") or default_sandbox or "").strip()
        if not sandbox:
            raise CliProviderError(
                "Не задан sandbox CLI: укажите llm.providers.<name>.sandbox "
                "или paths.data_dir ядра"
            )
        cli_path = str(block.get("cli_path") or "").strip()
        if not cli_path:
            cli_path = shutil.which(cli) or ""
        if not cli_path:
            raise CliProviderError(
                f"CLI '{cli}' не найден в PATH; задайте llm.providers.<name>.cli_path"
            )
        if "cli_roots" in block:
            raise CliProviderError(
                "cli_roots больше не поддерживаются: укажите cli_path в "
                "provider-runtimes/opencode/<platform>/<version>"
            )
        extra = block.get("extra_args")
        if extra not in (None, [], ()):
            raise CliProviderError(
                "extra_args не поддерживаются: CLI-лейн принимает только собранные ядром аргументы"
            )
        timeout_raw = block.get("timeout_seconds")
        timeout = (
            float(timeout_raw)
            if isinstance(timeout_raw, (int, float)) and timeout_raw > 0
            else DEFAULT_TIMEOUT_SECONDS
        )
        settings = cls(
            cli=cli,
            backend=backend,
            model=str(model),
            sandbox=sandbox,
            cli_path=cli_path,
            data_dir=str(data_root),
            auth_file=str(block.get("auth_file") or "").strip(),
            timeout=timeout,
            experimental=True,
        )
        validate_settings(settings)
        return settings


def _validate_cli_root(root: Path, settings: CliSettings) -> None:
    """Allowlist: только каталог версии OpenCode с проверенной версией.

    AR-68/75: принимается только каталог версии OpenCode с проверенной версией;
    всё остальное (широкие корни, `<data_dir>`, системные бинарники) — отказ.
    """
    root = root.expanduser().resolve()
    if str(root) in _WIDE_ROOTS or any(
        _is_under(root, item.resolve()) for item in PRE_MOUNTED_ROOTS
    ):
        raise CliProviderError(
            f"CLI-путь {root} — широкий корень ФС; укажите каталог версии OpenCode"
        )

    if not _is_opencode_runtime_root(root):
        raise CliProviderError(
            f"CLI-путь {root} вне разрешённых каталогов: нужен каталог версии "
            f"({RUNTIME_MARKER}/opencode/<platform>/<version>) с проверенной версией"
        )
    if root.name not in VERIFIED_OPENCODE_VERSIONS:
        raise CliProviderError(
            f"Версия OpenCode {root.name} не проверена: отключение инструментов "
            f"подтверждено только для {', '.join(sorted(VERIFIED_OPENCODE_VERSIONS))}"
        )

    data_root = Path(settings.data_dir).expanduser().resolve() if settings.data_dir else None
    if data_root is not None and (root == data_root or root in data_root.parents):
        raise CliProviderError(
            f"CLI-путь {root} открывает data_dir или его родителя; "
            "укажите каталог версии OpenCode"
        )
    if data_root is not None and _is_under(root, data_root):
        # AR-68: внутри data_dir разрешены только каталоги рантайма CLI,
        # иначе путь открывает память или vault процессу с сетью.
        runtime_ok = _is_under(root, data_root / "cli-runtime") or _is_under(
            root, data_root / SANDBOX_DIR_NAME / "runtime"
        )
        if not runtime_ok:
            raise CliProviderError(
                f"CLI-путь {root} лежит в data_dir вне cli-runtime/cli-sandbox/runtime; "
                "память и vault монтировать нельзя"
            )
    for sensitive in _SENSITIVE_TREES:
        base = Path(sensitive)
        if base == root or root in base.parents:
            raise CliProviderError(
                f"CLI-путь {root} открывает слишком широкий каталог; "
                "укажите каталог версии OpenCode"
            )


def validate_settings(settings: CliSettings) -> None:
    """Проверки конфига без создания каталогов: модель, sandbox, CLI-путь."""
    if not MODEL_PATTERN.match(str(settings.model or "")):
        raise CliProviderError(
            f"Модель CLI '{settings.model}' недопустима: разрешены буквы, цифры, . _ / : - "
            "без ведущего дефиса"
        )
    if settings.extra_args:
        raise CliProviderError(
            "extra_args не поддерживаются: CLI-лейн принимает только собранные ядром аргументы"
        )
    if not settings.data_dir:
        raise CliProviderError("CLI-провайдеру нужен paths.data_dir: sandbox живёт только внутри него")
    data_root = Path(settings.data_dir).expanduser().resolve()
    sandbox = _resolve_config_path(settings.sandbox, settings.data_dir)
    if sandbox.is_symlink():
        raise CliProviderError(f"Sandbox CLI не может быть симлинком: {sandbox}")
    resolved = sandbox.resolve()
    try:
        relative = resolved.relative_to(data_root)
    except ValueError as e:
        raise CliProviderError(
            f"Sandbox CLI {resolved} вне data_dir {data_root}: разрешён только "
            f"<data_dir>/{SANDBOX_DIR_NAME}"
        ) from e
    if not relative.parts or relative.parts[0] != SANDBOX_DIR_NAME:
        raise CliProviderError(
            f"Sandbox CLI {resolved} должен лежать в <data_dir>/{SANDBOX_DIR_NAME}"
        )
    # AR-71: OAuth в read-only auth.json не обновится — отказ на старте.
    if settings.auth_file:
        candidate = _resolve_config_path(settings.auth_file, settings.data_dir)
        if candidate.is_file() and _is_under(candidate.resolve(), resolved):
            _validate_auth_payload(candidate)
    else:
        for candidate in (
            resolved / "data" / "opencode" / "auth.json",
            resolved / "auth.json",
        ):
            if candidate.is_file():
                _validate_auth_payload(candidate)


def _resolve_config_path(value: str, data_dir: str, sandbox: Optional[Path] = None) -> Path:
    """Относительный путь в конфиге считается от data_dir, а не от cwd (AR-70)."""
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return candidate
    base = Path(data_dir).expanduser() if data_dir else (sandbox or Path.cwd())
    return base / candidate


def _ensure_sandbox(settings: CliSettings) -> Path:
    """Каталог sandbox на хосте: только внутри data_dir, не симлинк, создаётся в try."""
    sandbox = _resolve_config_path(settings.sandbox, settings.data_dir)
    if sandbox.is_symlink():
        raise CliProviderError(f"Sandbox CLI не может быть симлинком: {sandbox}")
    try:
        sandbox.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise CliProviderError(f"Песочница CLI недоступна: {sandbox}") from e
    resolved = sandbox.resolve()
    if not resolved.is_dir():
        raise CliProviderError(f"Песочница CLI не каталог: {resolved}")
    return resolved


# AR-71: конфиг 2.3.0 не умеет «ноль инструментов» — `tools: false` убирает
# только перечисленные имена, а `policies: tool.use` лишь запрещает запуск.
# Поэтому в запрос к модели инструменты вырезает плагин на хуке `context`:
# `event.tools` — это карта «имя → инструмент» уже собранного запроса.
PLUGIN_PACKAGE_JSON = """{
  "name": "neyra-no-tools",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js"
}
"""

PLUGIN_INDEX_JS = """import { writeFileSync } from "node:fs";

const NONCE = process.env.NEYRA_PLUGIN_NONCE || "";

function report(before, after) {
  try {
    writeFileSync(
      "/home/sandbox/state/plugin.json",
      JSON.stringify({ nonce: NONCE, before, after }),
    );
  } catch {
    // ядро увидит отсутствие манифеста и откажет (AR-75)
  }
}

export default {
  id: "neyra-no-tools",
  setup(ctx) {
    ctx.session.hook("context", (event) => {
      if (!event || !event.tools) return;
      const before = Object.keys(event.tools).length;
      for (const name of Object.keys(event.tools)) delete event.tools[name];
      report(before, Object.keys(event.tools).length);
    });
  },
};
"""


def _write_opencode_assets(sandbox: Path) -> Path:
    """Одноразовые конфиг и плагин: каталог уникален для вызова.

    Общий каталог не годится: параллельные ходы удаляли бы temp друг друга, и bwrap
    мог смонтировать пустой opencode.json — то есть стартовать без deny (AR-67).
    Каталог монтируется внутрь целиком, поэтому конфиг и плагин не разъезжаются.
    """
    try:
        root = Path(tempfile.mkdtemp(prefix=".opencode-", dir=sandbox))
    except OSError as e:
        raise CliProviderError(f"Не удалось создать конфиг OpenCode в {sandbox}: {e}") from e
    plugin_dir = root / "plugin"
    state_dir = root / "state"
    try:
        plugin_dir.mkdir()
        state_dir.mkdir()
        (plugin_dir / "package.json").write_text(PLUGIN_PACKAGE_JSON, encoding="utf-8")
        (plugin_dir / "index.js").write_text(PLUGIN_INDEX_JS, encoding="utf-8")
        config = root / "opencode.json"
        config.write_text(_opencode_config_text(), encoding="utf-8")
        for path in (config, plugin_dir / "package.json", plugin_dir / "index.js"):
            with open(path, "rb") as stream:
                os.fsync(stream.fileno())
    except OSError as e:
        _remove_quietly(root)
        raise CliProviderError(f"Не удалось записать конфиг OpenCode в {sandbox}: {e}") from e
    return root


def _remove_quietly(path: Path) -> None:
    try:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink()
    except OSError:
        return


def _find_auth_file(settings: CliSettings, sandbox: Path) -> Optional[Path]:
    """Файл авторизации OpenCode: read-only bind и только из sandbox (AR-69)."""

    def _checked(candidate: Path) -> Path:
        if candidate.is_symlink():
            raise CliProviderError(f"Файл авторизации CLI не может быть симлинком: {candidate}")
        resolved = candidate.resolve()
        if not resolved.is_file():
            raise CliProviderError(f"Файл авторизации CLI не найден: {resolved}")
        if not _is_under(resolved, sandbox):
            raise CliProviderError(
                f"Файл авторизации CLI {resolved} вне {SANDBOX_DIR_NAME}: "
                "секреты ядра в песочницу не монтируются"
            )
        _validate_auth_payload(resolved)
        return resolved

    if settings.auth_file:
        return _checked(_resolve_config_path(settings.auth_file, settings.data_dir))
    for candidate in (sandbox / "data" / "opencode" / "auth.json", sandbox / "auth.json"):
        if candidate.is_file() and not candidate.is_symlink():
            return _checked(candidate)
    return None


def _validate_auth_payload(path: Path) -> None:
    """AR-71: только API-ключ. OAuth-токен нельзя обновить в read-only файле."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise CliProviderError(
            f"Файл авторизации CLI не читается как JSON: {path}"
        ) from e
    if not isinstance(payload, dict) or not payload:
        raise CliProviderError(f"Файл авторизации CLI пуст или не объект: {path}")
    oauth = [
        name
        for name, item in payload.items()
        if not isinstance(item, dict) or item.get("type") != "api"
    ]
    if oauth:
        raise CliProviderError(
            "Файл авторизации CLI содержит не API-ключи ("
            + ", ".join(map(str, oauth))
            + "): OAuth-токен в read-only файле не обновится. Используйте API-ключ"
        )


def _cli_mount_root(cli_path: Path, settings: CliSettings) -> Path:
    """Каталог версии CLI для bind; всё остальное отклоняется в валидации."""
    parent = cli_path.parent
    root = parent.parent if parent.name in {"bin", "sbin"} else parent
    root = root.resolve()
    _validate_cli_root(root, settings)
    return root


def _messages_to_prompt(messages: Sequence[BaseMessage]) -> str:
    """CLI принимает один текст: system-части сверху, дальше реплики диалога."""
    system_parts: list[str] = []
    dialog: list[str] = []
    for message in messages:
        role = getattr(message, "type", "")
        text = _content_to_text(message.content)
        if role in {"system", "developer"}:
            system_parts.append(text)
        elif role == "human":
            dialog.append(f"Пользователь: {text}")
        elif role == "ai":
            dialog.append(f"Ассистент: {text}")
        elif role in {"tool", "function"}:
            raise CliProviderError("CLI-провайдер не поддерживает результаты инструментов")
        else:
            dialog.append(text)
    head = "\n\n".join([CLI_GUARD, *(part for part in system_parts if part.strip())])
    body = "\n\n".join(dialog)
    return f"{head}\n\n{body}".strip() if head else body


def _content_to_text(content: Any) -> str:
    """Текст из content: картинки и прочие блоки не сериализуются в base64."""
    if isinstance(content, str):
        return content
    if not isinstance(content, (list, tuple)):
        return str(content)
    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            parts.append(str(part))
            continue
        kind = str(part.get("type") or "").strip().lower()
        if kind in {"image", "image_url", "input_image"}:
            parts.append(IMAGE_PLACEHOLDER)
        elif kind in {"text", "input_text"}:
            parts.append(str(part.get("text") or ""))
        else:
            parts.append(f"[{kind or 'часть'} не передаётся CLI-провайдеру]")
    return "\n".join(item for item in parts if item)


def _parse_json_events(stdout: str) -> str:
    """Достать текст ответа из событий `--format json`."""
    chunks: list[str] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") != "text":
            continue
        part = event.get("part") if isinstance(event.get("part"), dict) else {}
        text = part.get("text")
        if isinstance(text, str) and text:
            chunks.append(text)
    return "".join(chunks).strip()


def _child_env(nonce: str) -> dict[str, str]:
    """Минимальное окружение потомка: без секретов ядра и токенов сервисов."""
    allowed = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM")
    env = {name: os.environ[name] for name in allowed if os.environ.get(name)}
    env.update(
        {
            # AR-75: одноразовый маркер, который печатает только наш плагин.
            "NEYRA_PLUGIN_NONCE": nonce,
            "HOME": SANDBOX_HOME,
            "TMPDIR": f"{SANDBOX_HOME}/tmp",
            "XDG_CACHE_HOME": f"{SANDBOX_HOME}/cache",
            "XDG_CONFIG_HOME": f"{SANDBOX_HOME}/config",
            "XDG_DATA_HOME": f"{SANDBOX_HOME}/data",
            "OPENCODE_CONFIG": SANDBOX_CONFIG_PATH,
        }
    )
    return env


def _bwrap_path() -> str:
    found = shutil.which("bwrap")
    if not found:
        raise CliProviderError(
            "bwrap не найден: CLI-провайдер отключён. Установите bubblewrap; "
            "прямой запуск без песочницы запрещён."
        )
    return str(Path(found).resolve())


def _parent_dirs(path: Path) -> list[str]:
    """Каталоги, которые нужно создать в namespace до bind CLI."""
    out: list[str] = []
    parent = path.parent
    while str(parent) not in {"", "/"}:
        out.append(str(parent))
        parent = parent.parent
    return list(reversed(out))


def _bwrap_argv(
    settings: CliSettings,
    cli_path: Path,
    *,
    assets: Path,
    auth_file: Optional[Path],
) -> list[str]:
    argv = [
        _bwrap_path(),
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--share-net",
    ]
    # Базовые системные каталоги: CLI и его динамические библиотеки.
    for source in ("/usr", "/bin", "/lib", "/lib64"):
        argv += ["--ro-bind-try", source, source]
    argv += ["--dir", "/etc"]
    for source in (
        "/etc/ssl",
        "/etc/ca-certificates",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/passwd",
        "/etc/group",
        "/etc/ld.so.cache",
    ):
        argv += ["--ro-bind-try", source, source]

    # HOME — свежий tmpfs: ни истории сессий, ни AGENTS.md, ни чужого конфига.
    argv += [
        "--dir",
        "/home",
        "--tmpfs",
        SANDBOX_HOME,
        "--dir",
        f"{SANDBOX_HOME}/tmp",
        "--dir",
        f"{SANDBOX_HOME}/cache",
        "--dir",
        SANDBOX_CONFIG_DIR,
        "--ro-bind",
        str(assets / "opencode.json"),
        SANDBOX_CONFIG_PATH,
        # AR-71: плагин вырезает инструменты из запроса к модели.
        "--ro-bind",
        str(assets / "plugin"),
        SANDBOX_PLUGIN_DIR,
        # AR-75: сюда плагин пишет манифест; каталог пуст на каждый вызов.
        "--bind",
        str(assets / "state"),
        SANDBOX_STATE_DIR,
    ]
    if auth_file is not None:
        argv += ["--dir", SANDBOX_AUTH_DIR, "--ro-bind", str(auth_file), SANDBOX_AUTH_PATH]
    argv += [
        "--tmpfs",
        "/tmp",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]

    cli_root = _cli_mount_root(cli_path, settings)
    # Монтируется после /tmp: иначе CLI внутри /tmp скрывается tmpfs.
    for parent in _parent_dirs(cli_path):
        if parent == "/tmp" or parent.startswith("/tmp/"):
            continue
        argv += ["--dir", parent]
    argv += ["--ro-bind", str(cli_root), str(cli_root)]
    argv += [
        "--chdir",
        SANDBOX_HOME,
        str(cli_path),
        "run",
        "--format",
        "json",
        "--model",
        settings.model,
    ]
    return argv


def _prepare(settings: CliSettings) -> tuple[list[str], dict[str, str], Path, str]:
    """Проверить конфиг, подготовить sandbox/конфиг/авторизацию и argv bwrap."""
    if not settings.experimental:
        raise CliProviderError(
            "CLI-провайдер не включён: нужен явный experimental: true в llm.providers.<name>"
        )
    validate_settings(settings)
    sandbox = _ensure_sandbox(settings)
    assets = _write_opencode_assets(sandbox)
    try:
        auth_file = _find_auth_file(settings, sandbox)
        cli_path = Path(settings.cli_path).expanduser().resolve()
        if not cli_path.is_file():
            raise CliProviderError(f"CLI не найден: {cli_path}")
        argv = _bwrap_argv(settings, cli_path, assets=assets, auth_file=auth_file)
    except BaseException:
        _remove_quietly(assets)
        raise
    nonce = secrets.token_hex(16)
    return argv, _child_env(nonce), assets, nonce


def _timeout_error(settings: CliSettings) -> CliProviderError:
    return CliProviderError(
        f"CLI не ответил за {settings.timeout:g} с (модель {settings.model})"
    )


def _output_error() -> CliProviderError:
    return CliProviderError(
        f"CLI вернул больше {MAX_OUTPUT_BYTES} байт вывода: процесс остановлен"
    )


def _kill_quietly(proc: Any) -> None:
    try:
        proc.kill()
    except (ProcessLookupError, OSError):
        return


def _run_sync(
    settings: CliSettings, argv: list[str], env: dict[str, str], prompt: str
) -> tuple[str, str, int]:
    """Popen с потолком вывода и watchdog-таймаутом; stderr вычитывается в потоке."""
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
    except OSError as e:
        raise CliProviderError(f"CLI не запустился: {e}") from e

    timed_out = threading.Event()

    def _on_timeout() -> None:
        timed_out.set()
        _kill_quietly(proc)

    timer = threading.Timer(settings.timeout, _on_timeout)
    timer.daemon = True
    timer.start()

    stderr_tail: list[str] = []

    def _drain_stderr() -> None:
        try:
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                if sum(len(item) for item in stderr_tail) < 8192:
                    stderr_tail.append(chunk)
        except (OSError, ValueError):
            return

    drain = threading.Thread(target=_drain_stderr, daemon=True)
    drain.start()
    try:
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
        try:
            stdout = proc.stdout.read(MAX_OUTPUT_BYTES + 1) or ""
        except (OSError, ValueError):
            stdout = ""
        if len(stdout.encode("utf-8", "ignore")) > MAX_OUTPUT_BYTES:
            _kill_quietly(proc)
            raise _output_error()
        try:
            returncode = proc.wait(timeout=max(1.0, settings.timeout))
        except subprocess.TimeoutExpired:
            _kill_quietly(proc)
            raise _timeout_error(settings)
    finally:
        timer.cancel()
        drain.join(timeout=1.0)

    if timed_out.is_set():
        raise _timeout_error(settings)
    return stdout, "".join(stderr_tail), returncode


def run_cli_prompt(settings: CliSettings, prompt: str) -> str:
    """Синхронный вызов OpenCode через bwrap. Возвращает текст ответа."""
    argv, env, assets, nonce = _prepare(settings)
    try:
        stdout, stderr, returncode = _run_sync(settings, argv, env, prompt)
        # AR-76: сначала настоящая ошибка CLI/ответ, потом проверка плагина.
        text = _answer_from_output(settings, stdout, stderr, returncode=returncode)
        _require_plugin_manifest(assets, nonce)
    finally:
        _remove_quietly(assets)
    return text


def _require_plugin_manifest(assets: Path, nonce: str) -> None:
    """AR-75: плагин обязан оставить манифест с пустым списком инструментов.

    stderr для этого не годится: OpenCode забирает вывод плагина в свой лог.
    Каталог `state` монтируется записываемым и пуст на каждый вызов, поэтому
    старый манифест не подойдёт.
    """
    path = Path(assets) / "state" / "plugin.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        payload = None
    if not isinstance(payload, dict):
        payload = None
    before = payload.get("before") if payload else None
    after = payload.get("after") if payload else None
    if (
        payload is None
        or payload.get("nonce") != nonce
        or type(before) is not int
        or before < 1
        or type(after) is not int
        or after != 0
    ):
        raise CliProviderError(
            "Плагин CLI не подтвердил отключение инструментов: ответ отклонён. "
            "Проверьте версию OpenCode и каталог плагина"
        )


def _reject_tool_events(stdout: str) -> None:
    """Fail-closed: если CLI всё-таки вызвал инструмент, ответ не отдаём (AR-71)."""
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        for part in _iter_event_parts(event):
            kind = str(part.get("type") or "")
            if kind in {"tool", "tool_use", "tool-call", "tool_call"} or "tool" in part:
                raise CliProviderError(
                    "CLI вызвал инструмент, хотя tools выключены: ответ отброшен"
                )


def _iter_event_parts(event: Any) -> Iterator[dict[str, Any]]:
    if isinstance(event, dict):
        yield event
        for value in event.values():
            yield from _iter_event_parts(value)
    elif isinstance(event, list):
        for item in event:
            yield from _iter_event_parts(item)


def _answer_from_output(
    settings: CliSettings, stdout: str, stderr: str, *, returncode: int
) -> str:
    if returncode != 0:
        tail = (stderr or stdout or "").strip().splitlines()[-3:]
        raise CliProviderError(f"CLI завершился с кодом {returncode}: {' | '.join(tail)}")
    _reject_tool_events(stdout)
    text = _parse_json_events(stdout)
    # JSON-ответ (память, рефлексия) может цитировать разметку как данные.
    try:
        structured = isinstance(json.loads(text), (dict, list))
    except ValueError:
        structured = False
    # Пример в fenced-блоке — это объяснение, а не вызов инструмента.
    prose = ""
    if not structured:
        prose = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
        prose = re.sub(r"``[^`]*``", "", prose)
        prose = re.sub(r"`[^`\n]*`", "", prose)
    if prose and any(pattern.search(prose) for pattern in TOOL_MARKUP_PATTERNS):
        raise CliProviderError(
            "CLI вернул разметку вызова инструмента вместо текста: ответ отклонён"
        )
    if not text:
        tail = (stderr or "").strip().splitlines()[-3:]
        raise CliProviderError(f"CLI не вернул текст ответа: {' | '.join(tail) or 'пусто'}")
    return text


# ─── Async-путь: отмена и таймаут убивают процесс ───────────────────────────

_SEMAPHORES: "weakref.WeakKeyDictionary[Any, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    semaphore = _SEMAPHORES.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(MAX_CONCURRENT_CLI)
        _SEMAPHORES[loop] = semaphore
    return semaphore


async def _read_capped(stream: Any, limit: int) -> bytes:
    """Читать поток, но не больше limit байт: лишнее — ошибка вывода."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise _output_error()
        chunks.append(chunk)
    return b"".join(chunks)


async def run_cli_prompt_async(settings: CliSettings, prompt: str) -> str:
    """Async-вызов OpenCode: CancelledError/таймаут убивают bwrap и всё дерево."""
    argv, env, assets, nonce = _prepare(settings)
    try:
        async with _semaphore():
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            try:
                async with asyncio.timeout(settings.timeout):
                    stdout, stderr = await _communicate(proc, prompt)
            except TimeoutError as e:
                _kill_quietly(proc)
                await _reap(proc)
                raise _timeout_error(settings) from e
            except asyncio.CancelledError:
                _kill_quietly(proc)
                await _reap(proc)
                raise
            except BaseException:
                _kill_quietly(proc)
                await _reap(proc)
                raise
        # AR-76: сначала настоящая ошибка CLI/ответ, потом проверка плагина.
        text = _answer_from_output(
            settings,
            (stdout or b"").decode("utf-8", "replace"),
            (stderr or b"").decode("utf-8", "replace"),
            returncode=proc.returncode or 0,
        )
        _require_plugin_manifest(assets, nonce)
    finally:
        _remove_quietly(assets)
    return text


async def _communicate(proc: Any, prompt: str) -> tuple[bytes, bytes]:
    async def _write() -> None:
        if proc.stdin is None:
            return
        try:
            proc.stdin.write(prompt.encode("utf-8"))
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            try:
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass

    writer = asyncio.ensure_future(_write())
    try:
        stdout, stderr = await asyncio.gather(
            _read_capped(proc.stdout, MAX_OUTPUT_BYTES),
            _read_capped(proc.stderr, MAX_OUTPUT_BYTES),
        )
    finally:
        if not writer.done():
            writer.cancel()
    await proc.wait()
    return stdout, stderr


async def _reap(proc: Any) -> None:
    """Дождаться убитого процесса, не давая зомби и висящим трубам."""
    try:
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (TimeoutError, asyncio.TimeoutError, ProcessLookupError, OSError):
        return


def _truncate_answer(settings: CliSettings, text: str, max_tokens: Optional[int]) -> str:
    """CLI не принимает лимит токенов: обрезаем ответ и пишем один warning."""
    if not max_tokens or max_tokens <= 0:
        return text
    limit = int(max_tokens) * CHARS_PER_TOKEN
    if len(text) <= limit:
        return text
    logger.warning(
        "CLI не поддерживает max_tokens=%s: ответ обрезан до %s символов (модель %s)",
        max_tokens,
        limit,
        settings.model,
    )
    return text[:limit].rstrip()


def _bound_limit(model: Any, kwargs: dict[str, Any]) -> Optional[int]:
    raw = kwargs.get("max_tokens")
    if raw is None:
        raw = getattr(model, "max_tokens", None)
    try:
        value = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None
    return value if value and value > 0 else None


def _apply_stop(text: str, stop: Optional[list[str]]) -> str:
    for token in stop or []:
        if token and token in text:
            text = text.split(token, 1)[0]
    return text


class CliChatModel(BaseChatModel):
    """LangChain-модель поверх CLI. Без инструментов; стрим — один chunk."""

    settings: CliSettings
    provider_name: str = "cli"

    @property
    def _llm_type(self) -> str:
        return f"cli-{self.settings.cli}"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "CliChatModel":  # noqa: D401
        raise CliProviderError(
            f"Провайдер '{self.provider_name}' не умеет инструменты: brain на CLI недоступен"
        )

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        prompt = _messages_to_prompt(messages)
        text = run_cli_prompt(self.settings, prompt)
        text = _truncate_answer(self.settings, text, _bound_limit(self, kwargs))
        text = _apply_stop(text, stop)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        prompt = _messages_to_prompt(messages)
        text = await run_cli_prompt_async(self.settings, prompt)
        text = _truncate_answer(self.settings, text, _bound_limit(self, kwargs))
        text = _apply_stop(text, stop)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Iterator[ChatGeneration]:
        """Без нативного стрима: отдаём ответ одним куском."""
        result = self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
        yield result.generations[0]

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        result = await self._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
        yield ChatGenerationChunk(message=AIMessageChunk(content=result.generations[0].message.content))
