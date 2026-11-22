"""Provider error bodies must not reach LTM logs or API results."""

import asyncio
import logging
from types import SimpleNamespace

import pytest

from core.memory import ltm_maintenance

SENTINEL = "provider-body-private-sentinel"


def _agent(raises=SENTINEL):
    long_memory = SimpleNamespace(
        encode_texts=lambda texts: [[1.0, 0.0] for _ in texts],
        rag_enabled=False,
    )

    async def summarize(*args, **kwargs):
        raise RuntimeError(raises)

    return SimpleNamespace(long_memory=long_memory, summarize_ltm_corpus=summarize)


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
    assert excinfo.value.error_class == "RuntimeError"
