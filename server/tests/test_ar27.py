"""Plugin tool must not expose raw provider output or internal error text."""

import json
import logging
from pathlib import Path

import pytest

from core.plugins import builder
from core.tools import builtins


@pytest.mark.parametrize("failure", ["json", "write", "manifest", "exception"])
def test_plugin_tool_failure_is_constant(tmp_path, monkeypatch, caplog, failure):
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(builder, "_repo_root", lambda: tmp_path)
    monkeypatch.setattr(builtins, "_neyra_config", {
        "llm": {"brain_model": {"provider": "ollama", "model": "offline-coder"}}
    })
    private = "PRIVATE_PROVIDER_OUTPUT_EXCEPTION"
    if failure == "exception":
        def generate(**kwargs):
            raise RuntimeError(private)
    else:
        def generate(**kwargs):
            if failure == "json":
                return private
            return json.dumps({"files": [
                {"path": "main.py", "content": "# offline test\n"},
                {"path": "plugin.yaml", "content": f"main_script: {private}.py\n"},
            ]})
    monkeypatch.setattr(builder, "_call_openai_chat", generate)
    if failure == "write":
        original = Path.write_text
        def write(path, *args, **kwargs):
            if path.name == "main.py":
                raise OSError(private)
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, "write_text", write)
    output = builtins.create_or_edit_plugin.invoke({"plugin_id": "demo", "task": "offline test", "api_key": "test-key"})
    assert output == "create_or_edit_plugin failed; see server log"
    assert private not in output
    assert not any(value in output for value in ("raw", "Traceback", "Exception"))
    if failure != "exception":
        reason = {"json": "Model output is not valid JSON", "write": "Write failed", "manifest": "Invalid plugin manifest"}[failure]
        assert any(record.name == builtins.logger.name and f"error={reason}" in record.getMessage() for record in caplog.records)
    if failure == "json":
        assert private not in caplog.text, "raw provider output must not be logged"
