"""CLI-провайдер: bwrap, запрет инструментов, allowlist путей, отмена, лимиты."""

from __future__ import annotations

import asyncio
import io
import json
import shutil
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from core.llm.cli_provider import (
    MAX_OUTPUT_BYTES,
    CliChatModel,
    CliProviderError,
    CliSettings,
    _cli_mount_root,
    _messages_to_prompt,
    _parse_json_events,
    _truncate_answer,
    run_cli_prompt,
    run_cli_prompt_async,
)

from test_web_identity_review import real_api  # noqa: F401  (fixture)

ADMIN = "admin"
TEXT_EVENT = json.dumps({"type": "text", "part": {"text": "ответ"}}, ensure_ascii=False)


def _runtime_bin(tmp_path: Path) -> Path:
    """Фейковый CLI в каталоге проверенной версии — единственный разрешённый вид."""
    path = (
        tmp_path
        / "provider-runtimes"
        / "opencode"
        / "linux-x64"
        / "2.3.0"
        / "bin"
        / "opencode"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("#!/bin/sh\n", encoding="utf-8")
        path.chmod(0o755)
    return path


def _settings(tmp_path: Path, cli_path: str | None = None, **changes) -> CliSettings:
    data = tmp_path / "data"
    values = dict(
        cli="opencode",
        backend="run",
        model="opencode/x-free",
        sandbox=str(data / "cli-sandbox"),
        data_dir=str(data),
        cli_path=cli_path if cli_path is not None else str(_runtime_bin(tmp_path)),
        experimental=True,
    )
    values.update(changes)
    return CliSettings(**values)


class _FakeStdin:
    def __init__(self):
        self.chunks: list[str] = []
        self.closed = False

    def write(self, data: str) -> None:
        self.chunks.append(data)

    def close(self) -> None:
        self.closed = True

    def getvalue(self) -> str:
        return "".join(self.chunks)


class _FakePopen:
    """Минимальный Popen: stdin/stdout/stderr как StringIO, без процессов."""

    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0):
        self.argv: list[str] = []
        self.kwargs: dict = {}
        self.stdin = _FakeStdin()
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.returncode = returncode
        self.killed = False

    def wait(self, timeout=None):  # noqa: ANN001, ARG002
        return self.returncode

    def kill(self):  # noqa: D401
        self.killed = True
        self.returncode = -9


def _patch_popen(
    monkeypatch,
    stdout: str = TEXT_EVENT,
    stderr: str = "",
    returncode: int = 0,
    markers: bool = True,
):
    holder: dict[str, _FakePopen] = {}

    def _factory(argv, **kwargs):  # noqa: ANN001
        nonce = (kwargs.get("env") or {}).get("NEYRA_PLUGIN_NONCE", "")
        if markers and nonce:
            state = _manifest_state_dir(argv)
            if state is not None:
                state.mkdir(parents=True, exist_ok=True)
                (state / "plugin.json").write_text(
                    json.dumps({"nonce": nonce, "before": 11, "after": 0}), encoding="utf-8"
                )
        proc = _FakePopen(stdout, stderr, returncode)
        proc.argv = list(argv)
        proc.kwargs = kwargs
        holder["proc"] = proc
        return proc

    monkeypatch.setattr("core.llm.cli_provider.subprocess.Popen", _factory)
    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: "/usr/bin/bwrap")
    return holder


def _manifest_state_dir(argv: list[str]) -> Path | None:
    """Хостовый каталог, смонтированный в /home/sandbox/state."""
    for index, item in enumerate(argv):
        if item == "/home/sandbox/state" and index >= 2 and argv[index - 2] in {"--bind", "--ro-bind"}:
            return Path(argv[index - 1])
    return None


def _config_text(tmp_path: Path) -> str:
    """Текст конфига, который ядро пишет в sandbox на вызов (AR-67)."""
    from core.llm.cli_provider import _opencode_config_text

    return _opencode_config_text()


def _flat(argv: list[str]) -> str:
    return " ".join(argv)


def test_bwrap_is_required_and_no_direct_fallback(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: None)
    with patch("core.llm.cli_provider.subprocess.Popen") as popen:
        with pytest.raises(CliProviderError, match="bwrap"):
            run_cli_prompt(_settings(tmp_path), "hi")
    popen.assert_not_called()


def test_argv_denies_tools_and_uses_throwaway_home(tmp_path: Path, monkeypatch):
    holder = _patch_popen(monkeypatch)
    assert run_cli_prompt(_settings(tmp_path), "не-в-argv") == "ответ"
    proc = holder["proc"]
    argv = proc.argv
    flat = _flat(argv)

    # AR-1: свежий tmpfs вместо постоянного writable HOME, конфиг ro.
    assert f"--tmpfs /home/sandbox" in flat
    assert f"--bind {tmp_path / 'data' / 'cli-sandbox'} /home/sandbox" not in flat
    # AR-67: конфиг уникален для вызова и монтируется read-only.
    assert "/home/sandbox/config/opencode/opencode.json" in flat
    assert "--ro-bind" in argv
    bound = Path(argv[argv.index("--ro-bind") + 1])
    assert bound.name == "opencode.json"
    assert bound.parent.name.startswith(".opencode-")
    assert proc.kwargs["env"]["OPENCODE_CONFIG"] == "/home/sandbox/config/opencode/opencode.json"
    # AR-71: плагин без инструментов монтируется рядом и включён в конфиг.
    assert f"--ro-bind {bound.parent / 'plugin'} /home/sandbox/plugin" in flat
    config = json.loads(_config_text(tmp_path))
    assert config["tools"] and not any(config["tools"].values())
    assert {"bash", "edit", "write", "webfetch", "execute"} <= set(config["permission"])
    assert set(config["permission"].values()) == {"deny"}
    assert config["plugins"] == ["/home/sandbox/plugin"]

    # AR-7: новая сессия (TIOCSTI) и без capabilities.
    assert "--new-session" in argv
    assert "--cap-drop" in argv and argv[argv.index("--cap-drop") + 1] == "ALL"

    # Промпт — stdin, не argv.
    assert "не-в-argv" not in flat
    assert proc.stdin.getvalue() == "не-в-argv"
    assert "--chdir /home/sandbox" in flat


def test_env_whitelist_has_no_core_secrets(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("API_TOKEN", "core-secret")
    monkeypatch.setenv("NEYRA_VAULT_KEY", "vault-secret")
    monkeypatch.setenv("DISCORD_TOKEN", "discord-secret")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram-secret")
    holder = _patch_popen(monkeypatch)
    run_cli_prompt(_settings(tmp_path), "hi")
    env = holder["proc"].kwargs["env"]
    for name in ("API_TOKEN", "NEYRA_VAULT_KEY", "DISCORD_TOKEN", "DEEPGRAM_API_KEY"):
        assert name not in env
    assert set(env) <= {
        "PATH",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "TERM",
        "HOME",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "OPENCODE_CONFIG",
        "NEYRA_PLUGIN_NONCE",
    }


def test_auth_file_is_mounted_read_only_from_sandbox(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    auth = Path(settings.sandbox) / "data" / "opencode" / "auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text("{}", encoding="utf-8")
    holder = _patch_popen(monkeypatch)
    run_cli_prompt(settings, "hi")
    argv = holder["proc"].argv
    flat = _flat(argv)
    assert f"--ro-bind {auth} /home/sandbox/data/opencode/auth.json" in flat
    assert holder["proc"].kwargs["env"]["XDG_DATA_HOME"] == "/home/sandbox/data"

    foreign = tmp_path / "foreign.json"
    foreign.write_text("{}", encoding="utf-8")
    with pytest.raises(CliProviderError, match="вне cli-sandbox"):
        run_cli_prompt(_settings(tmp_path, auth_file=str(foreign)), "hi")


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


def test_cli_root_allowlist(tmp_path: Path):
    settings = _settings(tmp_path)
    canonical = Path(
        "/var/lib/openbot/.config/OpenBot/provider-runtimes/opencode/linux-x64/2.3.0/bin/opencode"
    )
    assert _cli_mount_root(canonical, settings) == canonical.parent.parent

    for bad in (
        "/home/ebluffy/opencode/bin/opencode",
        "/root/opencode/bin/opencode",
        "/etc/opencode/bin/opencode",
        "/opt/neyra/server/data/opencode/bin/opencode",
        "/var/lib/openbot/.config/OpenBot/opencode/bin/opencode",
        "/var/lib/openbot/server/opencode/bin/opencode",
    ):
        with pytest.raises(CliProviderError):
            _cli_mount_root(Path(bad), settings)

    # AR-75: системный бинарник без каталога версии не принимается.
    with pytest.raises(CliProviderError, match="вне разрешённых|широкий"):
        _cli_mount_root(Path("/bin/echo"), settings)


def test_only_verified_opencode_version_is_allowed(tmp_path: Path):
    """AR-75: непроверенная версия CLI не получает доступ к песочнице."""
    from core.llm.cli_provider import _validate_cli_root

    settings = _settings(tmp_path)
    other = tmp_path / "provider-runtimes" / "opencode" / "linux-x64" / "9.9.9"
    other.mkdir(parents=True)
    with pytest.raises(CliProviderError, match="не проверена"):
        _validate_cli_root(other, settings)


def test_sandbox_must_live_in_data_dir(tmp_path: Path):
    data = tmp_path / "data"
    with pytest.raises(CliProviderError, match="cli-sandbox"):
        run_cli_prompt(_settings(tmp_path, sandbox=str(data)), "hi")
    with pytest.raises(CliProviderError, match="cli-sandbox"):
        run_cli_prompt(_settings(tmp_path, sandbox=str(data / "other")), "hi")
    with pytest.raises(CliProviderError, match="cli-sandbox"):
        run_cli_prompt(_settings(tmp_path, sandbox=str(tmp_path / "outside")), "hi")

    link = tmp_path / "link-sandbox"
    link.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(CliProviderError, match="симлинк"):
        run_cli_prompt(_settings(tmp_path, sandbox=str(link)), "hi")


def test_experimental_model_and_extra_args_are_validated(tmp_path: Path):
    data = str(tmp_path / "data")
    with pytest.raises(CliProviderError, match="experimental"):
        CliSettings.from_config(
            {"cli": "opencode", "cli_path": str(_runtime_bin(tmp_path))}, model="m", data_dir=data
        )
    with pytest.raises(CliProviderError, match="sandbox"):
        CliSettings.from_config(
            {"cli": "opencode", "cli_path": str(_runtime_bin(tmp_path)), "experimental": True, "sandbox": ""},
            model="m",
            data_dir=data,
        )
    with pytest.raises(CliProviderError, match="data_dir"):
        CliSettings.from_config(
            {"cli": "opencode", "cli_path": str(_runtime_bin(tmp_path)), "experimental": True}, model="m"
        )
    with pytest.raises(CliProviderError, match="Модель"):
        CliSettings.from_config(
            {"cli": "opencode", "cli_path": str(_runtime_bin(tmp_path)), "experimental": True},
            model="--port=1",
            data_dir=data,
            default_sandbox=str(Path(data) / "cli-sandbox"),
        )
    with pytest.raises(CliProviderError, match="extra_args"):
        CliSettings.from_config(
            {
                "cli": "opencode",
                "cli_path": str(_runtime_bin(tmp_path)),
                "experimental": True,
                "extra_args": ["--dangerously-skip-permissions"],
            },
            model="m",
            data_dir=data,
            default_sandbox=str(Path(data) / "cli-sandbox"),
        )


def test_broken_config_symlink_is_ignored_not_crashing(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    sandbox = Path(settings.sandbox)
    sandbox.mkdir(parents=True)
    (sandbox / "opencode.json").symlink_to(tmp_path / "missing.json")
    _patch_popen(monkeypatch)
    assert run_cli_prompt(settings, "hi") == "ответ"
    assert not list(sandbox.glob(".opencode-*.json"))


def test_output_cap_kills_process(tmp_path: Path, monkeypatch):
    holder = _patch_popen(monkeypatch, stdout="x" * (MAX_OUTPUT_BYTES + 10))
    with pytest.raises(CliProviderError, match="больше"):
        run_cli_prompt(_settings(tmp_path), "hi")
    assert holder["proc"].killed is True


def test_images_become_placeholder_not_base64():
    from langchain_core.messages import HumanMessage

    prompt = _messages_to_prompt(
        [
            HumanMessage(
                content=[
                    {"type": "text", "text": "что на фото?"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,QUJDREVG"},
                    },
                ]
            )
        ]
    )
    assert "что на фото?" in prompt
    assert "изображение не передано" in prompt
    assert "base64" not in prompt and "QUJDREVG" not in prompt


def test_max_tokens_truncates_answer(tmp_path: Path, monkeypatch):
    long_text = "я" * 500
    _patch_popen(
        monkeypatch,
        stdout=json.dumps({"type": "text", "part": {"text": long_text}}, ensure_ascii=False),
    )
    model = CliChatModel(settings=_settings(tmp_path), provider_name="oc")
    result = model.bind(max_tokens=10).invoke("привет")
    assert len(result.content) <= 10 * 4
    assert _truncate_answer(_settings(tmp_path), long_text, None) == long_text


class _BlockingStream:
    async def read(self, limit: int) -> bytes:  # noqa: ARG002
        await asyncio.sleep(30)
        return b""


class _FakeAsyncStdin:
    def write(self, data: bytes) -> None:  # noqa: ARG002
        return None

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None


class _FakeAsyncProc:
    def __init__(self):
        self.stdin = _FakeAsyncStdin()
        self.stdout = _BlockingStream()
        self.stderr = _BlockingStream()
        self.returncode = None
        self.killed = False

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int:
        while self.returncode is None:
            await asyncio.sleep(0.01)
        return self.returncode


def test_cancelled_async_run_kills_process(tmp_path: Path, monkeypatch):
    proc = _FakeAsyncProc()

    async def _spawn(*argv, **kwargs):  # noqa: ANN002, ANN003
        return proc

    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: "/usr/bin/bwrap")
    monkeypatch.setattr("core.llm.cli_provider.asyncio.create_subprocess_exec", _spawn)

    async def _run():
        with pytest.raises((TimeoutError, asyncio.TimeoutError)):
            await asyncio.wait_for(run_cli_prompt_async(_settings(tmp_path), "hi"), 0.05)
        return proc.killed

    assert asyncio.run(_run()) is True


def test_async_stream_returns_single_chunk(tmp_path: Path, monkeypatch):
    payload = json.dumps({"type": "text", "part": {"text": "поток"}}, ensure_ascii=False).encode()

    class _ReadyStream:
        def __init__(self, data: bytes):
            self.data = data

        async def read(self, limit: int) -> bytes:
            chunk, self.data = self.data[:limit], self.data[limit:]
            return chunk

    proc = _FakeAsyncProc()
    proc.stdout = _ReadyStream(payload)
    proc.stderr = _ReadyStream(b"")

    async def _spawn(*argv, **kwargs):  # noqa: ANN002, ANN003
        nonce = (kwargs.get("env") or {}).get("NEYRA_PLUGIN_NONCE", "")
        state = _manifest_state_dir(list(argv))
        if state is not None:
            state.mkdir(parents=True, exist_ok=True)
            (state / "plugin.json").write_text(
                json.dumps({"nonce": nonce, "before": 11, "after": 0}), encoding="utf-8"
            )
        proc.returncode = 0
        return proc

    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: "/usr/bin/bwrap")
    monkeypatch.setattr("core.llm.cli_provider.asyncio.create_subprocess_exec", _spawn)
    model = CliChatModel(settings=_settings(tmp_path), provider_name="oc")

    async def _collect():
        return [chunk async for chunk in model.astream("привет")]

    chunks = asyncio.run(_collect())
    assert chunks and chunks[0].content == "поток"
    assert "".join(str(chunk.content or "") for chunk in chunks) == "поток"


def test_actual_bwrap_denies_tools_and_forgets_home(tmp_path: Path):
    if not shutil.which("bwrap"):
        pytest.skip("bwrap not installed in this environment")
    runtime = (
        tmp_path
        / "provider-runtimes"
        / "opencode"
        / "linux-x64"
        / "2.3.0"
        / "bin"
    )
    runtime.mkdir(parents=True, exist_ok=True)
    script = runtime / "opencode"
    script.write_text(
        "#!/bin/sh\n"
        "read line\n"
        'printf \'{"nonce":"%s","before":11,"after":0}\\n\' "$NEYRA_PLUGIN_NONCE" > "$HOME/state/plugin.json"\n'
        'if [ ! -f "$HOME/.seen" ]; then\n'
        '  touch "$HOME/.seen"\n'
        '  if grep -q \'"bash": false\' "$OPENCODE_CONFIG"; then\n'
        "    printf '%s\\n' '{\"type\":\"text\",\"part\":{\"text\":\"clean\"}}'\n"
        "  else\n"
        "    printf '%s\\n' '{\"type\":\"text\",\"part\":{\"text\":\"config-missing\"}}'\n"
        "  fi\n"
        "else\n"
        "  printf '%s\\n' '{\"type\":\"text\",\"part\":{\"text\":\"state-leaked\"}}'\n"
        "fi\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    settings = _settings(tmp_path, cli_path=str(script))
    assert run_cli_prompt(settings, "hello") == "clean"
    # tmpfs HOME на каждый вызов: файл первого вызова во втором не виден.
    assert run_cli_prompt(settings, "hello") == "clean"


def _cli_agent(tmp_path: Path, **extra) -> SimpleNamespace:
    block = {
        "kind": "cli",
        "cli": "opencode",
        "cli_path": "/bin/echo",
        "experimental": True,
        "sandbox": str(tmp_path / "data" / "cli-sandbox"),
    }
    config = {
        "paths": {"data_dir": str(tmp_path / "data")},
        "llm": {
            "providers": {"oc": block, "plain": {"base_url": "http://127.0.0.1:11434/v1"}},
            "talk_model": {"provider": "oc", "model": "opencode/x"},
            "brain_model": {"provider": "oc", "model": "opencode/x"},
            "memory_model": {"provider": "oc", "model": "opencode/x"},
            "vision_model": {"provider": "oc", "model": "opencode/x"},
        },
    }
    config.update(extra)
    return SimpleNamespace(config=config)


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


def test_brain_cli_with_tools_is_refused_at_setup(tmp_path: Path):
    from core.agent.llm_setup import setup_llm_connection

    with pytest.raises(CliProviderError, match="tools"):
        setup_llm_connection(_cli_agent(tmp_path, mcp_client={"llm_tool_calls": True}))
    with pytest.raises(CliProviderError, match="tools"):
        setup_llm_connection(_cli_agent(tmp_path, desktop_agent={"enabled": True}))


def test_brain_tool_loop_is_skipped_without_tool_support():
    from core.agent.brain_phase import _brain_tool_loop_enabled

    tools = {"client.open_url": object()}
    assert _brain_tool_loop_enabled(
        SimpleNamespace(llm_brain_capabilities={"supports_tool_calls": False}), tools
    ) is False
    assert _brain_tool_loop_enabled(SimpleNamespace(llm_brain_capabilities={}), tools) is True
    assert _brain_tool_loop_enabled(SimpleNamespace(), {}) is False


def test_unified_brain_vision_is_disabled_for_cli_brain(tmp_path: Path):
    from core.agent.llm_setup import setup_llm_connection

    agent = _cli_agent(tmp_path)
    llm = agent.config["llm"]
    llm["brain_model"] = {"provider": "oc", "model": "opencode/x"}
    llm["vision_model"] = {
        "enabled": True,
        "use_brain_model_for_vision": True,
        "provider": "plain",
        "model": "some-vl",
    }
    setup_llm_connection(agent)
    assert agent.llm_vision is None


def test_provider_put_does_not_rewrite_cli_kind(real_api, auth_headers):
    http, agent = real_api
    agent._setup_llm = lambda: None
    cfg = http.app.state.config
    blocks = cfg.setdefault("llm", {}).setdefault("providers", {})
    blocks["oc"] = {
        "kind": "cli",
        "cli": "opencode",
        "experimental": True,
        "sandbox": str(Path(cfg["paths"]["data_dir"]) / "cli-sandbox"),
    }
    response = http.put(
        "/v1/providers/oc",
        json={"base_url": "http://192.168.1.10:8000/v1", "kind": "openai"},
        headers=auth_headers[ADMIN],
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "provider_kind_cli"
    assert blocks["oc"]["kind"] == "cli"

    created = http.put(
        "/v1/providers/cli-only",
        json={"base_url": "http://192.168.1.10:8000/v1", "kind": "cli"},
        headers=auth_headers[ADMIN],
    )
    assert created.status_code == 409


# ─── Второй раунд авторевью #77 (AR-67…AR-71) ────────────────────────────────


def test_cli_root_must_be_verified_version_dir(tmp_path: Path):
    """AR-68/75: принимается только каталог проверенной версии OpenCode."""
    from core.llm.cli_provider import _validate_cli_root

    settings = _settings(tmp_path)
    # Подкаталоги широких префиксов не открывают диск «на один компонент глубже».
    for bad in (
        "/run",
        "/run/media",
        "/run/media/ebluffy",
        "/run/user/1000",
        "/mnt/data",
        "/media/disk",
        "/var/log",
        "/var/lib/other",
        "/srv/www",
        "/tmp/tools",
        "/home/someone/opencode",
        "/root/opencode",
        "/etc/opencode",
        "/data",
        "/backup",
        "/usr/local",
    ):
        with pytest.raises(
            CliProviderError,
            match="нельзя монтировать|широкий корень|вне разрешённых|слишком широкий",
        ):
            _validate_cli_root(Path(bad), settings)

    runtime = tmp_path / "provider-runtimes" / "opencode" / "linux-x64" / "2.3.0"
    runtime.mkdir(parents=True, exist_ok=True)
    _validate_cli_root(runtime, settings)  # каталог версии OpenCode — можно

    # AR-75: произвольная поставка без каталога версии не принимается.
    with pytest.raises(CliProviderError, match="вне разрешённых"):
        _validate_cli_root(Path("/opt/vendor/opencode"), settings)
    with pytest.raises(CliProviderError, match="нельзя монтировать|вне разрешённых"):
        _validate_cli_root(runtime / "bin", settings)


def test_auth_file_must_stay_inside_sandbox(tmp_path: Path):
    """AR-69: vault и память ядра в песочницу не монтируются."""
    settings = _settings(tmp_path)
    data = Path(settings.data_dir)
    (data / "memory").mkdir(parents=True)
    (data / "memory" / "vault.json").write_text("{}", encoding="utf-8")
    bad = _settings(
        tmp_path,
        auth_file=str(data / "memory" / "vault.json"),
    )
    with pytest.raises(CliProviderError, match="вне cli-sandbox"):
        run_cli_prompt(bad, "hi")


def test_relative_paths_resolve_from_data_dir(tmp_path: Path, monkeypatch):
    """AR-70: относительные sandbox/auth_file не зависят от cwd."""
    _patch_popen(monkeypatch)
    settings = _settings(tmp_path, sandbox="cli-sandbox")
    data = Path(settings.data_dir)
    (data / "cli-sandbox" / "data" / "opencode").mkdir(parents=True)
    (data / "cli-sandbox" / "data" / "opencode" / "auth.json").write_text("{}", encoding="utf-8")
    settings = _settings(tmp_path, sandbox="cli-sandbox", auth_file="cli-sandbox/data/opencode/auth.json")
    assert run_cli_prompt(settings, "hi") == "ответ"


def test_plugin_manifest_is_required_fail_closed(tmp_path: Path, monkeypatch):
    """AR-75: без манифеста плагина ответ отклоняется, а не уходит с инструментами."""
    _patch_popen(monkeypatch, markers=False)
    with pytest.raises(CliProviderError, match="не подтвердил отключение инструментов"):
        run_cli_prompt(_settings(tmp_path), "hi")


def test_plugin_manifest_nonce_and_tools_are_checked(tmp_path: Path):
    """AR-75: чужой nonce или оставшиеся инструменты не считаются успехом."""
    from core.llm.cli_provider import _require_plugin_manifest

    assets = tmp_path / "assets"
    (assets / "state").mkdir(parents=True)
    manifest = assets / "state" / "plugin.json"

    with pytest.raises(CliProviderError, match="не подтвердил"):
        _require_plugin_manifest(assets, "cafe")  # файла нет

    manifest.write_text(json.dumps({"nonce": "deadbeef", "before": 11, "after": 0}), encoding="utf-8")
    with pytest.raises(CliProviderError, match="не подтвердил"):
        _require_plugin_manifest(assets, "cafe")

    manifest.write_text(json.dumps({"nonce": "cafe", "before": 11, "after": 3}), encoding="utf-8")
    with pytest.raises(CliProviderError, match="не подтвердил"):
        _require_plugin_manifest(assets, "cafe")

    for bad in (
        {"nonce": "cafe", "before": 0, "after": 0},
        {"nonce": "cafe", "before": True, "after": 0},
        {"nonce": "cafe", "before": 11, "after": False},
        {"nonce": "cafe", "before": 11},
    ):
        manifest.write_text(json.dumps(bad), encoding="utf-8")
        with pytest.raises(CliProviderError, match="не подтвердил"):
            _require_plugin_manifest(assets, "cafe")

    manifest.write_text(json.dumps({"nonce": "cafe", "before": 11, "after": 0}), encoding="utf-8")
    _require_plugin_manifest(assets, "cafe")


def test_async_real_cli_error_is_not_masked_by_plugin_check(tmp_path: Path, monkeypatch):
    """AR-76: async-путь тоже отдаёт ошибку CLI раньше проверки плагина."""
    class _ReadyStream:
        def __init__(self, data: bytes):
            self.data = data

        async def read(self, limit: int) -> bytes:
            chunk, self.data = self.data[:limit], self.data[limit:]
            return chunk

    proc = _FakeAsyncProc()
    proc.stdout = _ReadyStream(b"")
    proc.stderr = _ReadyStream(b"auth missing")

    async def _spawn(*argv, **kwargs):  # noqa: ANN002, ANN003
        proc.returncode = 2
        return proc

    monkeypatch.setattr("core.llm.cli_provider.shutil.which", lambda name: "/usr/bin/bwrap")
    monkeypatch.setattr("core.llm.cli_provider.asyncio.create_subprocess_exec", _spawn)

    with pytest.raises(CliProviderError, match="кодом 2"):
        asyncio.run(run_cli_prompt_async(_settings(tmp_path), "hi"))


def test_real_cli_error_is_not_masked_by_plugin_check(tmp_path: Path, monkeypatch):
    """AR-76: ошибка CLI (нет авторизации, модель) важнее сообщения про плагин."""
    _patch_popen(monkeypatch, stdout="", stderr="auth missing", returncode=2, markers=False)
    with pytest.raises(CliProviderError, match="кодом 2"):
        run_cli_prompt(_settings(tmp_path), "hi")


def test_tool_event_fails_closed(tmp_path: Path, monkeypatch):
    """AR-71: если CLI всё-таки вызвал инструмент, ответ не отдаём."""
    tool_event = json.dumps(
        {"type": "tool_use", "part": {"tool": "bash", "input": {"command": "id"}}},
        ensure_ascii=False,
    )
    _patch_popen(monkeypatch, stdout=tool_event + "\n" + TEXT_EVENT + "\n")
    with pytest.raises(CliProviderError, match="вызвал инструмент"):
        run_cli_prompt(_settings(tmp_path), "hi")


def test_example_config_points_inside_default_data_dir():
    """AR-70: пример llm.example.yaml не ведёт на /opt/neyra/data."""
    example = Path(__file__).resolve().parents[1] / "config" / "llm.example.yaml"
    text = example.read_text(encoding="utf-8")
    assert "/opt/neyra/data" not in text
    assert "cli-sandbox" in text


def test_prepare_uses_per_call_config_with_tools_denied(tmp_path: Path):
    """AR-67: параллельные вызовы не делят конфиг и не публикуют пустой файл."""
    from concurrent.futures import ThreadPoolExecutor

    from core.llm.cli_provider import _prepare

    settings = _settings(tmp_path)
    Path(settings.sandbox).mkdir(parents=True, exist_ok=True)

    def _one(_: int):
        argv, _env, assets, _nonce = _prepare(settings)
        payload = json.loads((Path(assets) / "opencode.json").read_text(encoding="utf-8"))
        assert payload["permission"]["bash"] == "deny", payload
        assert payload["tools"]["bash"] is False, payload
        assert payload["plugins"] == ["/home/sandbox/plugin"], payload
        plugin_dir = Path(assets) / "plugin"
        assert (plugin_dir / "index.js").is_file()
        assert "delete event.tools" in (plugin_dir / "index.js").read_text(encoding="utf-8")
        shutil.rmtree(assets)
        return str(assets)

    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(_one, range(64)))
    assert len(set(paths)) == len(paths)
    assert not list(Path(settings.sandbox).glob(".opencode-*"))


def test_real_2_3_0_events_are_parsed_and_tool_events_rejected(tmp_path: Path):
    """AR-71: фикстуры — сырой вывод настоящего 2.3.0, не выдуманный JSON."""
    from core.llm.cli_provider import _answer_from_output, _reject_tool_events

    fixtures = Path(__file__).parent / "fixtures" / "cli"
    clean = (fixtures / "opencode-2.3.0-text.jsonl").read_text(encoding="utf-8")
    assert _answer_from_output(_settings(tmp_path), clean, "", returncode=0) == "pong"
    _reject_tool_events(clean)  # чистое событие не падает

    tool = (fixtures / "opencode-2.3.0-tool-use.jsonl").read_text(encoding="utf-8")
    with pytest.raises(CliProviderError, match="инструмент"):
        _reject_tool_events(tool)


def test_tool_events_are_rejected_fail_closed(tmp_path: Path):
    """AR-71: если CLI всё-таки вызвал инструмент, ответ не отдаётся."""
    from core.llm.cli_provider import _answer_from_output

    raw = "\n".join(
        [
            json.dumps({"type": "tool", "part": {"tool": "bash", "input": {"cmd": "id"}}}),
            TEXT_EVENT,
        ]
    )
    with pytest.raises(CliProviderError, match="инструмент"):
        _answer_from_output(_settings(tmp_path), raw, "", returncode=0)
