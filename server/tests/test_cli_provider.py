"""CLI-провайдер: разбор событий, конфиг и запрет инструментов. Без сети."""

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from core.llm.cli_provider import (
    CliChatModel,
    CliProviderError,
    CliSettings,
    _messages_to_prompt,
    _parse_json_events,
    run_cli_prompt,
)
from langchain_core.messages import HumanMessage, SystemMessage


def test_json_events_parse_text_only():
    raw = "\n".join(
        json.dumps(event)
        for event in (
            {"type": "step_start", "part": {"type": "step-start"}},
            {"type": "text", "part": {"type": "text", "text": "При"}},
            {"type": "text", "part": {"type": "text", "text": "вет"}},
            {"type": "step_finish", "part": {}},
        )
    )
    assert _parse_json_events(raw) == "Привет"


def test_settings_require_known_cli(tmp_path: Path):
    with pytest.raises(CliProviderError):
        CliSettings.from_config({"cli": "something-else"}, model="m")
    settings = CliSettings.from_config(
        {"cli": "opencode", "cli_path": "/bin/echo", "sandbox": str(tmp_path)},
        model="opencode/x-free",
    )
    assert settings.backend == "run"
    assert settings.model == "opencode/x-free"


def test_prompt_keeps_system_and_dialog():
    prompt = _messages_to_prompt([SystemMessage(content="Ты Нейра"), HumanMessage(content="привет")])
    assert prompt.startswith("Ты Нейра")
    assert "Пользователь: привет" in prompt


def test_run_cli_prompt_parses_stdout(tmp_path: Path):
    settings = CliSettings(
        cli="opencode",
        backend="run",
        model="opencode/x-free",
        sandbox=str(tmp_path),
        cli_path="/bin/echo",
    )
    stdout = json.dumps({"type": "text", "part": {"text": "ответ"}})
    completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")
    with patch("core.llm.cli_provider.subprocess.run", return_value=completed) as run:
        assert run_cli_prompt(settings, "привет") == "ответ"
    assert run.call_args.kwargs["cwd"] == str(tmp_path)


def test_run_cli_prompt_reports_failure(tmp_path: Path):
    settings = CliSettings(
        cli="opencode",
        backend="run",
        model="opencode/x-free",
        sandbox=str(tmp_path),
        cli_path="/bin/false",
    )
    completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="boom")
    with patch("core.llm.cli_provider.subprocess.run", return_value=completed):
        with pytest.raises(CliProviderError):
            run_cli_prompt(settings, "привет")


def test_bind_tools_is_refused(tmp_path: Path):
    model = CliChatModel(
        settings=CliSettings(
            cli="opencode",
            backend="run",
            model="opencode/x-free",
            sandbox=str(tmp_path),
            cli_path="/bin/true",
        ),
        provider_name="oc",
    )
    with pytest.raises(CliProviderError):
        model.bind_tools([])


def test_generate_returns_text(tmp_path: Path):
    model = CliChatModel(
        settings=CliSettings(
            cli="opencode",
            backend="run",
            model="opencode/x-free",
            sandbox=str(tmp_path),
            cli_path="/bin/true",
        ),
        provider_name="oc",
    )
    with patch("core.llm.cli_provider.run_cli_prompt", return_value="Четыре"):
        result = model.invoke([HumanMessage(content="2+2?")])
    assert result.content == "Четыре"


def test_health_skips_cli_providers():
    from core.llm.profile import iter_unique_provider_connections

    cfg = {
        "llm": {
            "talk_model": {"provider": "llama", "model": "local"},
            "memory_model": {"provider": "oc", "model": "opencode/x-free"},
            "providers": {
                "llama": {"base_url": "http://127.0.0.1:11434/v1", "kind": "local"},
                "oc": {"kind": "cli", "cli": "opencode", "cli_path": "/bin/echo"},
            },
        }
    }
    providers = [c.provider for c in iter_unique_provider_connections(cfg)]
    assert providers == ["llama"]
