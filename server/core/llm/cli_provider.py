"""CLI-провайдер: лейн Neyra отвечает через официальный CLI, не через прокси.

Первый минимальный бэкенд — `opencode run --format json`: один процесс на
запрос, в песочнице, с моделью из конфига. Авторизация живёт в самом CLI,
Нейра ключей не видит и не логирует промпты целиком.

Контракт для ядра — обычная LangChain-модель: `BaseChatModel` с `_generate`,
поэтому лейны, ретраи, таймауты и трассировка остаются прежними.

Ограничения (осознанные, для M1):
* нет стриминга — ответ приходит целиком;
* нет tool calling — лейн `brain` на CLI запрещён, пока не появится адаптер
  с инструментами;
* картинки не передаются — `vision` пока не поддерживается.
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
DEFAULT_SANDBOX = "/var/lib/openbot/neyra-cli-sandbox"


class CliProviderError(RuntimeError):
    """CLI не найден, упал или вернул мусор вместо ответа."""


@dataclass(frozen=True)
class CliSettings:
    cli: str
    backend: str
    model: str
    sandbox: str
    cli_path: str
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    extra_args: tuple[str, ...] = ()

    @classmethod
    def from_config(cls, block: dict[str, Any], *, model: str) -> "CliSettings":
        cli = str(block.get("cli") or "opencode").strip().lower()
        if cli not in CLI_KINDS:
            raise CliProviderError(f"CLI '{cli}' пока не поддерживается: {', '.join(CLI_KINDS)}")
        backend = str(block.get("backend") or "run").strip().lower()
        if backend not in CLI_BACKENDS:
            raise CliProviderError(f"Бэкенд CLI '{backend}' пока не поддерживается: {', '.join(CLI_BACKENDS)}")
        sandbox = str(block.get("sandbox") or DEFAULT_SANDBOX).strip()
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


def run_cli_prompt(settings: CliSettings, prompt: str) -> str:
    """Синхронный вызов CLI. Возвращает текст ответа, исключения — CliProviderError."""
    sandbox = Path(settings.sandbox)
    try:
        sandbox.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise CliProviderError(f"Песочница CLI недоступна: {sandbox}") from e

    argv = [
        settings.cli_path,
        "run",
        prompt,
        "--format",
        "json",
        "--model",
        settings.model,
        *settings.extra_args,
    ]
    env = dict(os.environ)
    env.pop("OPENAI_API_KEY", None)
    env.pop("ANTHROPIC_API_KEY", None)

    try:
        completed = subprocess.run(
            argv,
            cwd=str(sandbox),
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
            f"Провайдер '{self.provider_name}' не умеет инструменты: лейн brain на CLI пока нельзя"
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
