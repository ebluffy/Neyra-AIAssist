"""Provider error bodies must not reach LTM logs or API results."""

import asyncio
import logging
import traceback
from types import SimpleNamespace

import pytest

from core.agent.session_archive import archive_session
from core.llm import retry
from core.memory import ltm_maintenance
from core.reflection.engine import ReflectionEngine

SENTINEL = "provider-body-private-sentinel"


def _agent(raises=SENTINEL):
    long_memory = SimpleNamespace(
        encode_texts=lambda texts: [[1.0, 0.0] for _ in texts],
        rag_enabled=False,
    )

    async def summarize(*args, **kwargs):
        raise RuntimeError(raises)

    return SimpleNamespace(long_memory=long_memory, summarize_ltm_corpus=summarize)


def _raiser():
    async def failure(*args, **kwargs):
        raise RuntimeError(SENTINEL)

    return failure


def _reflection_engine(tmp_path):
    agent = SimpleNamespace(
        diary=SimpleNamespace(add_entry=lambda **kwargs: True),
        llm_memory=object(),
        memory_hub=None,
        event_bus=SimpleNamespace(publish=lambda *a, **k: None),
    )
    config = {"logging": {"chat_log": str(tmp_path / "chat.log")}, "memory": {}}
    return ReflectionEngine(config, agent)


def test_clustered_summarize_does_not_log_provider_body(tmp_path, caplog):
    rows = [
        ("id-1", {"user_id": "owner"}, "fact one about the user"),
        ("id-2", {"user_id": "owner"}, "fact two about the user"),
    ]
    cm = ltm_maintenance._read_cluster_merge_cfg(
        {"ltm_cluster_merge": {"log_dir": str(tmp_path / "ltm")}}
    )
    with caplog.at_level(logging.WARNING):
        result = asyncio.run(
            ltm_maintenance._clustered_execute_ltm_summarize(
                _agent(),
                {"memory": {}},
                tmp_path,
                rows=rows,
                older_than_days=60,
                types=None,
                max_entries=10,
                digest_source="test",
                cm=cm,
            )
        )
    assert SENTINEL not in caplog.text
    assert "error_class=RuntimeError" in caplog.text
    assert result["consolidation"]["failed_clusters"]


def test_scheduled_summarize_does_not_return_or_log_provider_body(tmp_path, caplog, monkeypatch):
    async def boom(*args, **kwargs):
        raise RuntimeError(SENTINEL)

    monkeypatch.setattr(ltm_maintenance, "execute_ltm_summarize", boom)
    config = {"memory": {"ltm_auto_summarize": {"enabled": True}}}
    with caplog.at_level(logging.WARNING):
        result = asyncio.run(
            ltm_maintenance.run_scheduled_summarize(_agent(), config, root=tmp_path)
        )
    assert SENTINEL not in caplog.text
    assert SENTINEL not in str(result)
    assert result["error"] == "RuntimeError"


def test_legacy_summarize_sanitizes_provider_error(tmp_path):
    rows = [("id-1", {"user_id": "owner"}, "fact one about the user")]
    with pytest.raises(ltm_maintenance.LtmSummarizeError) as excinfo:
        asyncio.run(
            ltm_maintenance._legacy_execute_ltm_summarize(
                _agent(),
                {"memory": {}},
                tmp_path,
                rows=rows,
                older_than_days=60,
                types=None,
                max_entries=10,
                compress_with_llm=True,
                digest_source="test",
            )
        )
    assert SENTINEL not in str(excinfo.value)
    assert SENTINEL not in "".join(traceback.format_exception(excinfo.value))
    assert excinfo.value.error_class == "RuntimeError"
    assert excinfo.value.__cause__ is None and excinfo.value.__suppress_context__


def test_session_archive_does_not_log_provider_body(caplog):
    async def summarize(*args, **kwargs):
        raise RuntimeError(SENTINEL)

    hub = SimpleNamespace(
        list_chat=lambda **kwargs: [{"role": "user", "text": "hello from the user"}],
        add_diary_note=lambda *a, **k: None,
    )
    agent = SimpleNamespace(
        config={
            "memory": {
                "session_archive": {
                    "enabled": True,
                    "on_manual_reset": True,
                    "write_diary": False,
                    "write_ltm_digest": True,
                }
            }
        },
        short_memory=SimpleNamespace(get_history=lambda: [], clear=lambda: None),
        memory_hub=hub,
        summarize_ltm_corpus=summarize,
    )
    with caplog.at_level(logging.WARNING):
        result = asyncio.run(
            archive_session(agent, reason="manual_reset", user_id="owner")
        )
    assert result["ran"] is True
    assert SENTINEL not in caplog.text
    assert "error_class=RuntimeError" in caplog.text


def test_hourly_diary_does_not_log_provider_body(tmp_path, caplog, monkeypatch):
    engine = _reflection_engine(tmp_path)
    logs = "\n".join(f"line {i}" for i in range(8))
    monkeypatch.setattr(engine, "_get_logs_for_last_hour", lambda: logs)
    monkeypatch.setattr(retry, "ainvoke_with_rate_limit_backoff", _raiser())
    with caplog.at_level(logging.ERROR):
        out = asyncio.run(engine.hourly_diary_note())
    assert out == ""
    assert SENTINEL not in caplog.text
    assert "error_class=RuntimeError" in caplog.text


def test_small_reflection_does_not_log_provider_body(tmp_path, caplog, monkeypatch):
    engine = _reflection_engine(tmp_path)
    logs = "\n".join(f"line {i}" for i in range(8))
    monkeypatch.setattr(engine, "_get_logs_for_last_hours", lambda hours: logs)
    monkeypatch.setattr(retry, "ainvoke_with_rate_limit_backoff", _raiser())
    with caplog.at_level(logging.ERROR):
        out = asyncio.run(engine.small_reflection())
    assert out == ""
    assert SENTINEL not in caplog.text
    assert "error_class=RuntimeError" in caplog.text
