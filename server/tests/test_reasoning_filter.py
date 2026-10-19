"""Reasoning tags can span arbitrary token boundaries and remain unclosed."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk

from core.agent.reasoning_filter import ReasoningFilter
from core.agent.reply_postprocess import extract_think_blocks
from core.api.app import build_app
from offline_support import offline_agent


@pytest.mark.parametrize("raw,expected", [
    ("plain text", "plain text"),
    ("2 < 3 and <b>bold</b>", "2 < 3 and <b>bold</b>"),
    ("a trailing <", "a trailing <"),
    ("<think>PRIVATE</think>answer", "answer"),
    ("<ThOuGhT>PRIVATE</tHoUgHt>answer", "answer"),
    ("start <redacted_thinking>PRIVATE</redacted_thinking>end", "start end"),
    ("<think>PRIVATE", ""),
    ("answer<thought>PRIVATE", "answer"),
    ("<think>outer<thought>inner</thought>PRIVATE</think>answer", "answer"),
    ("<think>PRIVATE</thought>STILL-PRIVATE</think>answer", "answer"),
    ("<think>PRIVATE</think>a<thought>PRIVATE</thought>b", "ab"),
])
def test_all_token_splits_match_final_sanitization(raw, expected):
    assert extract_think_blocks(raw)[0] == expected
    for split in range(len(raw) + 1):
        filter = ReasoningFilter()
        assert filter.feed(raw[:split]) + filter.feed(raw[split:]) + filter.finish() == expected
    filter = ReasoningFilter()
    assert "".join(filter.feed(char) for char in raw) + filter.finish() == expected


@pytest.mark.parametrize("transport", ["stream", "ws"])
@pytest.mark.parametrize("unclosed", [False, True])
def test_real_stream_never_publishes_reasoning_tokens(tmp_path, transport, unclosed):
    agent = offline_agent(tmp_path)
    raw = "PUBLIC-ANSWER<ThInK>PRIVATE-REASONING" if unclosed else "<ThInK>PRIVATE-REASONING</think>PUBLIC-ANSWER"

    async def stream(messages):
        agent.llm_talk.messages.append(messages)
        for char in raw:
            yield AIMessageChunk(content=char)
    agent.llm_talk.astream = stream
    try:
        if transport == "stream":
            async def collect():
                return [item async for item in agent.chat_stream("hello")]
            output = asyncio.run(collect())
        else:
            app = build_app(
                agent.config, shared_agent=agent, project_root=tmp_path,
                shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
                shared_backup_manager=MagicMock(),
            )
            output = []
            with TestClient(app) as client:
                with client.websocket_connect("/v1/ws/chat", headers={"Authorization": "Bearer offline-admin-token"}) as ws:
                    assert ws.receive_json()["type"] == "hello"
                    ws.send_json({"type": "chat", "text": "hello"})
                    while True:
                        item = ws.receive_json()
                        output.append(item)
                        if item["type"] in ("error", "done"):
                            break
        assert output[-1]["type"] == "done"
        assert output[-1]["text"] == "PUBLIC-ANSWER"
        assert "".join(item["text"] for item in output if item["type"] == "token") == "PUBLIC-ANSWER"
        assert "PRIVATE-REASONING" not in str(agent.memory_hub.list_chat(limit=10))
        assert "PRIVATE-REASONING" not in str(agent.short_memory.windows())
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize("error", [TimeoutError("mid-stream timeout"), RuntimeError("context_length_exceeded")])
def test_partial_public_stream_is_kept_and_not_replayed(tmp_path, error):
    agent = offline_agent(tmp_path)
    agent._publish_chat_turn_failed = MagicMock()
    attempts = []

    async def stream(messages):
        attempts.append(messages)
        yield AIMessageChunk(content="PUBLIC-PARTIAL")
        raise error
    agent.llm_talk.astream = stream

    async def collect():
        return [item async for item in agent.chat_stream("hello")]
    try:
        output = asyncio.run(collect())
        assert len(attempts) == 1
        assert "".join(item["text"] for item in output if item["type"] == "token") == "PUBLIC-PARTIAL"
        assert output[-1]["type"] == "done"
        assert output[-1]["text"] == "PUBLIC-PARTIAL"
        assert output[-1]["model_trace"]["status"] == "completed"
        assert output[-1]["model_trace"]["error_class"] == type(error).__name__
        assert "mid-stream" not in str(output[-1]["model_trace"])
        assert "context_length_exceeded" not in str(output[-1]["model_trace"])
        assert any(row["text"] == "PUBLIC-PARTIAL" for row in agent.memory_hub.list_chat(limit=10))
        agent._publish_chat_turn_failed.assert_not_called()
    finally:
        agent.memory_hub.close()
