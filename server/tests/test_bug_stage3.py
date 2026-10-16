"""Offline regressions for the Stage 3 server bug fixes."""

import asyncio
import json
import logging

from core.api.log_redaction import install_log_filters
from core.plugins import builder
from core.runtime.mcp_client import MCPClientManager
from modules.discord.music_intent import resolve_music_route


def test_plugin_builder_does_not_send_plugin_yaml_to_model(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    plugin = root / "modules" / "demo"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("api_key: provider-secret\n", encoding="utf-8")
    captured = {}

    monkeypatch.setattr(builder, "_repo_root", lambda: root)
    monkeypatch.setattr(
        builder,
        "_call_openai_chat",
        lambda **kwargs: captured.update(kwargs)
        or json.dumps(
            {
                "files": [
                    {"path": "plugin.yaml", "content": 'main_script: "main.py"\n'},
                    {"path": "main.py", "content": "def run(): pass\n"},
                ]
            }
        ),
    )
    result = builder.create_or_edit_plugin_impl(
        plugin_id="demo", task="update", api_key="test-key",
        config={"llm": {"brain_model": {"provider": "ollama", "model": "offline-coder"}}},
    )

    assert result["ok"] is True
    assert result["existed"] is True
    assert "provider-secret" not in captured["user"]
    assert "plugin.yaml" not in captured["user"]


def test_missing_mcp_executable_does_not_reconnect():
    manager = MCPClientManager({"mcp_client": {"enabled": True, "servers": {"browsermcp": {"transport": "stdio", "command": "missing"}}}})

    async def run():
        task = asyncio.create_task(manager._run_server_forever("browsermcp", manager._specs["browsermcp"]))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        manager._shutdown.set()
        await asyncio.wait_for(task, timeout=1)

    asyncio.run(run())
    assert manager._errors["browsermcp"] == "missing executable"


def test_gif_does_not_trigger_music_but_explicit_play_is_preserved():
    assert resolve_music_route("покажи смешной gif")[1] is False
    assert resolve_music_route("play gif song")[1] is True


def test_library_search_logger_is_redacted_and_does_not_emit_traceback(caplog):
    install_log_filters(extra_secrets=["search-secret"])
    logger = logging.getLogger("ddgs")
    with caplog.at_level(logging.ERROR):
        logger.error("https://search.test/?q=search-secret", exc_info=True)
    assert "search-secret" not in caplog.text
    assert "Traceback" not in caplog.text
