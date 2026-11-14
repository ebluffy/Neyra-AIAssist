"""CLI-провайдер: bwrap, env whitelist, stdin, JSON и staging-публикация."""

from __future__ import annotations

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
    _parse_json_events,
    run_cli_prompt,
)


def _settings(tmp_path: Path, cli_path: str = "/bin/echo", **changes) -> CliSettings:
    values = dict(
        cli="opencode",
        backend="run",
        model="opencode/x-free",
        sandbox=str(tmp_path / "sandbox"),
        cli_path=cli_path,
        experimental=True,
    )
    values.update(changes)
    return CliSettings(**values)


def test_bwrap_is_required_and_no_direct_fallback(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: None)
    with patch("core.llm.cli_provider.subprocess.run") as run:
        with pytest.raises(CliProviderError, match="bwrap"):
            run_cli_prompt(_settings(tmp_path), "hi")
    run.assert_not_called()


def test_argv_has_bwrap_mounts_and_prompt_is_stdin(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: "/usr/bin/bwrap")
    completed = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout=json.dumps({"type": "text", "part": {"text": "ответ"}}),
        stderr="",
    )
    with patch("core.llm.cli_provider.subprocess.run", return_value=completed) as run:
        assert run_cli_prompt(_settings(tmp_path), "не-в-argv") == "ответ"
    argv = run.call_args.args[0]
    flat = " ".join(argv)
    assert "--unshare-user" in flat and "--unshare-pid" in flat
    assert "--share-net" in flat
    assert "--die-with-parent" in flat
    assert f"--bind {tmp_path / 'sandbox'} /home/sandbox" in flat
    assert "--chdir /home/sandbox" in flat
    assert "не-в-argv" not in flat
    assert run.call_args.kwargs["input"] == "не-в-argv"
    assert run.call_args.kwargs["env"]["HOME"] == "/home/sandbox"


def test_env_whitelist_has_no_core_secrets(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("API_TOKEN", "core-secret")
    monkeypatch.setenv("NEYRA_VAULT_KEY", "vault-secret")
    monkeypatch.setenv("DISCORD_TOKEN", "discord-secret")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram-secret")
    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: "/usr/bin/bwrap")
    completed = subprocess.CompletedProcess(args=[], returncode=0, stdout='{"type":"text","part":{"text":"ok"}}', stderr="")
    with patch("core.llm.cli_provider.subprocess.run", return_value=completed) as run:
        run_cli_prompt(_settings(tmp_path), "hi")
    env = run.call_args.kwargs["env"]
    for name in ("API_TOKEN", "NEYRA_VAULT_KEY", "DISCORD_TOKEN", "DEEPGRAM_API_KEY"):
        assert name not in env
    assert set(env) <= {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"}


def test_json_events_and_bind_tools(tmp_path: Path):
    raw = "\n".join(
        json.dumps(event)
        for event in (
            {"type": "step_start"},
            {"type": "text", "part": {"text": "При"}},
            {"type": "text", "part": {"text": "вет"}},
        )
    )
    assert _parse_json_events(raw) == "Привет"

    model = CliChatModel(settings=_settings(tmp_path), provider_name="oc")
    with pytest.raises(CliProviderError, match="инструменты"):
        model.bind_tools([])


def test_experimental_and_sandbox_are_required(tmp_path: Path):
    with pytest.raises(CliProviderError, match="experimental"):
        CliSettings.from_config({"cli": "opencode", "cli_path": "/bin/echo"}, model="m")
    with pytest.raises(CliProviderError, match="sandbox"):
        CliSettings.from_config(
            {"cli": "opencode", "cli_path": "/bin/echo", "experimental": True}, model="m"
        )


def test_actual_bwrap_runs_prompt_through_stdin(tmp_path: Path):
    if not __import__("shutil").which("bwrap"):
        pytest.skip("bwrap not installed in this environment")
    cli_dir = tmp_path / "cli"
    cli_dir.mkdir()
    script = cli_dir / "opencode"
    script.write_text(
        "#!/bin/sh\n"
        "read line\n"
        "printf '%s\\n' '{\"type\":\"text\",\"part\":{\"text\":\"sandbox-ok\"}}'\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    settings = _settings(tmp_path, cli_path=str(script))
    assert run_cli_prompt(settings, "hello") == "sandbox-ok"


def _cli_agent(tmp_path: Path) -> SimpleNamespace:
    block = {
        "kind": "cli",
        "cli": "opencode",
        "cli_path": "/bin/echo",
        "experimental": True,
        "sandbox": str(tmp_path / "sandbox"),
    }
    return SimpleNamespace(
        config={
            "paths": {"data_dir": str(tmp_path / "data")},
            "llm": {
                "providers": {"oc": block},
                "talk_model": {"provider": "oc", "model": "opencode/x"},
                "brain_model": {"provider": "oc", "model": "opencode/x"},
                "memory_model": {"provider": "oc", "model": "opencode/x"},
                "vision_model": {"provider": "oc", "model": "opencode/x"},
            },
        }
    )


def test_cli_lanes_are_staged_and_vision_cli_does_not_crash(tmp_path: Path):
    from core.agent.llm_setup import setup_llm_connection

    agent = _cli_agent(tmp_path)
    setup_llm_connection(agent)
    assert isinstance(agent.llm_talk, CliChatModel)
    assert isinstance(agent.llm_brain, CliChatModel)
    assert isinstance(agent.llm_memory, CliChatModel)
    assert agent.llm_vision is None
    assert agent._cli_vision is True
    with pytest.raises(CliProviderError):
        agent.llm_brain.bind_tools([])


def test_broad_cli_root_is_refused(tmp_path: Path):
    from core.llm.cli_provider import _validate_cli_root

    with pytest.raises(CliProviderError):
        _validate_cli_root(Path("/var/lib/openbot"), tmp_path / "sandbox")
    with pytest.raises(CliProviderError):
        _validate_cli_root(Path("/opt"), tmp_path / "sandbox")
    # A versioned OpenCode directory is allowed.
    _validate_cli_root(Path("/var/lib/openbot/.config/OpenBot/provider-runtimes/opencode/linux-x64/2.3.0"),
                       tmp_path / "sandbox")
