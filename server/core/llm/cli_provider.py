"""CLI-провайдер OpenCode в настоящей песочнице bwrap.

Запуск возможен только через `bwrap`: без него провайдер отказывает, прямого
fallback нет. Внутри namespaces видны read-only системные каталоги, сам CLI
(read-only), writable sandbox как `/home/sandbox`, `/tmp`, `/proc`, `/dev`.
Сеть остаётся (`--share-net`), потому что OpenCode ходит к модели; инструменты
OpenCode работают внутри sandbox и не видят хост-ФС, `/opt/neyra`, `.env`,
`data` и секреты ядра.

Env потомка — whitelist: PATH/LANG/LC_*/TZ/TERM и HOME/TMPDIR/XDG внутри
sandbox. `API_TOKEN`, `NEYRA_*`, Discord/Deepgram-токены не передаются.
Промпт идёт через stdin, не в argv.

Ограничения: нет стриминга; brain на CLI не умеет tools (`bind_tools`
бросает понятную ошибку); vision на CLI не поддерживается.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult

logger = logging.getLogger("neyra.llm_cli")

CLI_KINDS: tuple[str, ...] = ("opencode",)
CLI_BACKENDS: tuple[str, ...] = ("run",)
DEFAULT_TIMEOUT_SECONDS = 120.0
SANDBOX_HOME = "/home/sandbox"


class CliProviderError(RuntimeError):
    """CLI не найден, bwrap недоступен, процесс упал или вернул мусор."""


@dataclass(frozen=True)
class CliSettings:
    cli: str
    backend: str
    model: str
    sandbox: str
    cli_path: str
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    extra_args: tuple[str, ...] = ()
    experimental: bool = False

    @classmethod
    def from_config(
        cls,
        block: dict[str, Any],
        *,
        model: str,
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
        sandbox = str(block.get("sandbox") or default_sandbox).strip()
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
        timeout_raw = block.get("timeout_seconds")
        timeout = float(timeout_raw) if isinstance(timeout_raw, (int, float)) and timeout_raw > 0 else DEFAULT_TIMEOUT_SECONDS
        extra = block.get("extra_args")
        extra_args = tuple(str(a) for a in extra) if isinstance(extra, list) else ()
        return cls(
            cli=cli,
            backend=backend,
            model=model,
            sandbox=sandbox,
            cli_path=cli_path,
            timeout=timeout,
            extra_args=extra_args,
            experimental=True,
        )


def _messages_to_prompt(messages: Sequence[BaseMessage]) -> str:
    """CLI принимает один текст: system-части сверху, дальше реплики диалога."""
    system_parts: list[str] = []
    dialog: list[str] = []
    for message in messages:
        role = getattr(message, "type", "")
        content = message.content
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
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
    head = "\n\n".join(part for part in system_parts if part.strip())
    body = "\n\n".join(dialog)
    return f"{head}\n\n{body}".strip() if head else body


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


def _child_env(sandbox: Path) -> dict[str, str]:
    """Минимальное окружение потомка: без секретов ядра и токенов сервисов."""
    allowed = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM")
    env = {name: os.environ[name] for name in allowed if os.environ.get(name)}
    env.update(
        {
            "HOME": SANDBOX_HOME,
            "TMPDIR": f"{SANDBOX_HOME}/tmp",
            "XDG_CACHE_HOME": f"{SANDBOX_HOME}/cache",
            "XDG_CONFIG_HOME": f"{SANDBOX_HOME}/config",
            "XDG_DATA_HOME": f"{SANDBOX_HOME}/data",
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


def _validate_cli_root(cli_root: Path, sandbox: Path) -> None:
    """Не давать bind'ом открыть весь /var/lib/openbot, /.config или /opt/neyra."""
    root = cli_root.resolve()
    if root == Path("/"):
        raise CliProviderError("CLI не может лежать в корне ФС: укажите каталог версии OpenCode")
    for sensitive in (Path("/var/lib/openbot/.config"), Path("/opt/neyra")):
        if root == sensitive or root in sensitive.parents:
            raise CliProviderError(
                f"CLI-путь {root} открывает слишком широкий каталог; "
                "укажите каталог версии OpenCode, например .../provider-runtimes/opencode/.../2.3.0"
            )
    try:
        sandbox.resolve().relative_to(root)
    except ValueError:
        pass
    else:
        raise CliProviderError("Sandbox не может находиться внутри read-only каталога CLI")


def _bwrap_argv(settings: CliSettings, cli_path: Path) -> list[str]:
    sandbox = Path(settings.sandbox)
    argv = [
        _bwrap_path(),
        "--die-with-parent",
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

    argv += [
        "--dir", "/home",
        "--bind", str(sandbox), SANDBOX_HOME,
        "--tmpfs", "/tmp",
        "--proc", "/proc",
        "--dev", "/dev",
    ]
    # OpenCode read-only по тому же пути, но не весь /var/lib/openbot.
    # Монтируется после /tmp: иначе CLI в /tmp скрывается tmpfs.
    _validate_cli_root(cli_path.parent, sandbox)
    cli_root = str(cli_path.parent)
    for parent in _parent_dirs(cli_path):
        if parent == "/tmp" or parent.startswith("/tmp/"):
            continue
        argv += ["--dir", parent]
    argv += ["--ro-bind", cli_root, cli_root]
    argv += [
        "--chdir", SANDBOX_HOME,
        str(cli_path),
        "run",
        "--format",
        "json",
        "--model",
        settings.model,
        *settings.extra_args,
    ]
    return argv


def run_cli_prompt(settings: CliSettings, prompt: str) -> str:
    """Синхронный вызов OpenCode через bwrap. Возвращает текст ответа."""
    if not settings.experimental:
        raise CliProviderError(
            "CLI-провайдер не включён: нужен явный experimental: true в llm.providers.<name>"
        )
    sandbox = Path(settings.sandbox)
    try:
        sandbox.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise CliProviderError(f"Песочница CLI недоступна: {sandbox}") from e
    for subdir in ("tmp", "cache", "config", "data"):
        (sandbox / subdir).mkdir(parents=True, exist_ok=True)

    cli_path = Path(settings.cli_path).resolve()
    if not cli_path.is_file():
        raise CliProviderError(f"CLI не найден: {cli_path}")
    argv = _bwrap_argv(settings, cli_path)
    env = _child_env(sandbox)

    try:
        completed = subprocess.run(
            argv,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=settings.timeout,
            env=env,
        )
    except subprocess.TimeoutExpired as e:
        raise CliProviderError(
            f"CLI не ответил за {settings.timeout:g} с (модель {settings.model})"
        ) from e
    except OSError as e:
        raise CliProviderError(f"CLI не запустился: {e}") from e

    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-3:]
        raise CliProviderError(f"CLI завершился с кодом {completed.returncode}: {' | '.join(tail)}")

    text = _parse_json_events(completed.stdout)
    if not text:
        tail = (completed.stderr or "").strip().splitlines()[-3:]
        raise CliProviderError(f"CLI не вернул текст ответа: {' | '.join(tail) or 'пусто'}")
    return text


class CliChatModel(BaseChatModel):
    """LangChain-модель поверх CLI. Без стриминга и без инструментов."""

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
        if stop:
            for token in stop:
                if token and token in text:
                    text = text.split(token, 1)[0]
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
