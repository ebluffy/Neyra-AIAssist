"""Latency evidence for failed turns, queue wait and Responses HTTP. No control-flow changes."""

import asyncio
import json
import logging
import time
from concurrent.futures import Future

import httpx
import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

from core.agent.conversation_scope import conversation_scope
from core.agent.model_trace import (
    ACTIVE_TRACE,
    TurnTrace,
    begin_call,
    invoke,
)
from core.agent.responses_talk import ResponsesRetryable, _safe_target
from core.agent.talk_sessions import sessions_for
from core.llm.profile import OpenAICompatibleConnection
from offline_support import OfflineResponsesGateway, offline_agent


def _rows(agent):
    return agent.memory_hub.sqlite._conn.execute(
        "SELECT role, text, user_id, channel_id, meta FROM chat_log"
    ).fetchall()


def test_safe_target_drops_userinfo_and_query():
    assert _safe_target("https://user:secret@aihope.fun/v1/responses?api_key=secret") == "https://aihope.fun/v1/responses"
    assert _safe_target("/v1/responses") == "/v1/responses"


def test_failed_and_cancelled_turns_are_stored_outside_dialogue(tmp_path):
    agent = offline_agent(tmp_path)
    agent.llm_brain.failures = 1
    try:
        owner = agent._resolve_internal_user_id("123", None)
        assert owner != "123"
        failed = asyncio.run(agent.chat("PRIVATE-USER-TEXT", discord_user_id="123", channel_id="77"))
        assert failed["model_trace"]["status"] == "failed"
        assert failed["model_trace"]["error_class"] == "RuntimeError"
        assert failed["model_trace"]["calls"][-1]["error_class"] == "RuntimeError"
        assert agent.memory_hub.list_chat(limit=10) == []
        stored = _rows(agent)
        assert len(stored) == 1 and stored[0]["role"] == "model_trace" and stored[0]["text"] == ""
        assert stored[0]["user_id"] == owner
        blob = stored[0]["meta"]
        assert "PRIVATE-USER-TEXT" not in blob and "123" not in blob
        assert json.loads(blob)["model_trace"]["turn_id"] == failed["model_trace"]["turn_id"]
        manager = sessions_for(agent)
        manager.gates[conversation_scope(owner, "77").key] = Future()
        entered = asyncio.Event()
        original = manager.enter

        async def enter(scope, *, wait_warmup=True):
            entered.set()
            return await original(scope, wait_warmup=wait_warmup)

        manager.enter = enter

        async def cancel():
            task = asyncio.create_task(agent.chat("PRIVATE-CANCEL-TEXT", discord_user_id="123", channel_id="77"))
            await asyncio.wait_for(entered.wait(), 2)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(cancel())
        evidence = [row for row in _rows(agent) if row["role"] == "model_trace"]
        assert len(evidence) == 2
        cancelled_row = evidence[-1]
        cancelled = json.loads(cancelled_row["meta"])["model_trace"]
        assert cancelled["status"] == "cancelled"
        assert cancelled["error_class"] == "CancelledError"
        assert cancelled["queue_wait_ms"] >= 0
        assert cancelled_row["user_id"] == owner
        assert "123" not in (cancelled_row["user_id"] or "")
        assert "PRIVATE-CANCEL-TEXT" not in cancelled_row["meta"]
        assert agent.memory_hub.list_chat(limit=10) == []
    finally:
        agent.memory_hub.close()


def test_queue_wait_covers_session_gate_and_warmup(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config["llm"]["talk_model"]["responses"] = {"enabled": True, "warmup_on_start": False}
    agent._llm_conn_talk = OpenAICompatibleConnection("offline", "http://gateway.invalid/v1", "synthetic-secret")
    agent._responses_transport = httpx.MockTransport(OfflineResponsesGateway())
    manager = sessions_for(agent)
    ready = Future()
    manager.warming = ready
    started = asyncio.Event()
    original = manager.enter

    async def enter(scope, *, wait_warmup=True):
        started.set()
        return await original(scope, wait_warmup=wait_warmup)

    manager.enter = enter
    try:
        async def run():
            task = asyncio.create_task(agent.chat("hello", discord_user_id="123", channel_id="77"))
            await asyncio.wait_for(started.wait(), 2)
            await asyncio.sleep(0.2)
            ready.set_result(None)
            return await task

        out = asyncio.run(run())
        assert out["model_trace"]["queue_wait_ms"] >= 150
        talk = next(call for call in out["model_trace"]["calls"] if call["purpose"] == "reply")
        assert talk["duration_ms"] < out["model_trace"]["queue_wait_ms"]
        assert out["model_trace"]["duration_ms"] >= out["model_trace"]["queue_wait_ms"]
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize("stream", [False, True])
def test_responses_timings_and_http_log_omit_secrets(tmp_path, caplog, stream):
    agent = offline_agent(tmp_path)
    agent.config["llm"]["talk_model"]["responses"] = {"enabled": True, "warmup_on_start": False}
    agent._llm_conn_talk = OpenAICompatibleConnection("offline", "http://gateway.invalid/v1", "synthetic-secret")
    gateway = OfflineResponsesGateway()
    agent._responses_transport = httpx.MockTransport(gateway)
    caplog.set_level(logging.INFO, logger="neyra.llm.http")
    try:
        async def run():
            if stream:
                return [chunk async for chunk in agent.chat_stream("hello", discord_user_id="123", channel_id="77")][-1]
            return await agent.chat("hello", discord_user_id="123", channel_id="77")

        out = asyncio.run(run())
        purpose = "stream_reply" if stream else "reply"
        call = next(item for item in out["model_trace"]["calls"] if item["purpose"] == purpose and item["status"] == "completed")
        assert call["http_status"] == 200
        assert call["headers_ms"] is not None and call["headers_ms"] >= 0
        assert call["duration_ms"] >= call["headers_ms"]
        assert call["sdk_retries"] == 0 and call["retry_layer"] is None
        if stream:
            assert call["first_event_type"] == "response.created"
            assert call["first_event_ms"] >= call["headers_ms"]
            assert call["first_text_delta_ms"] >= call["first_event_ms"]
            assert call["first_meaningful_token_ms"] >= call["first_text_delta_ms"]
        else:
            assert call["first_event_type"] is None
        lines = [rec.message for rec in caplog.records if rec.name == "neyra.llm.http" and rec.message.startswith("HTTP Request: POST")]
        assert len(lines) == 1
        assert "/v1/responses" in lines[0] and "status=200" in lines[0] and "duration_ms=" in lines[0]
        secret = " ".join(rec.message for rec in caplog.records if rec.name == "neyra.llm.http")
        assert "synthetic-secret" not in secret and "Bearer" not in secret
        assert "hello" not in secret and "Offline persona" not in secret and "api_key" not in secret
    finally:
        agent.memory_hub.close()


def test_retry_layer_labels_and_sdk_counter_ignore_the_message(tmp_path):
    agent = offline_agent(tmp_path)
    trace = TurnTrace("123", "77", agent.config)
    token = ACTIVE_TRACE.set(trace)
    state = {"n": 0}

    async def flaky(messages, llm=None):
        state["n"] += 1
        if state["n"] == 1:
            raise ResponsesRetryable("responses_history_unavailable PRIVATE")
        return AIMessage(content="ok")

    async def run():
        await invoke(agent, None, [], lane="talk", purpose="reply", invoker=flaky)
        await invoke(agent, None, [], lane="talk", purpose="empty_reply_retry", invoker=lambda messages, llm=None: asyncio.sleep(0, AIMessage(content="ok")))
        call = begin_call(agent, "talk", "stream_reply")
        record = logging.LogRecord(
            "openai._base_client", logging.INFO, __file__, 1,
            "Retrying request in %f seconds (retry %i of %s)",
            (0.4, 1, "https://user:secret@gateway.invalid/v1/chat/completions"),
            None,
        )
        logging.getLogger("openai._base_client").handle(record)
        assert call["sdk_retries"] == 1
        assert "secret" not in json.dumps(trace.report())

    try:
        asyncio.run(run())
        assert [(c["retry_layer"], c["status"], c["error_class"]) for c in trace.calls[:2]] == [
            (None, "failed", "ResponsesRetryable"),
            ("responses_history", "completed", None),
        ]
        assert trace.calls[2]["retry_layer"] == "empty_reply"
        assert "PRIVATE" not in json.dumps(trace.report())
    finally:
        ACTIVE_TRACE.reset(token)
        agent.memory_hub.close()


def test_reasoning_keeps_a_slow_stream_alive_without_publishing_it(tmp_path):
    from core.agent.llm_stream import astream_text_with_fallback
    agent = offline_agent(tmp_path)
    agent.primary_first_token_timeout = 0.1
    agent.config["llm"]["talk_model"]["turn_timeout_seconds"] = 1

    async def stream(messages):
        await asyncio.sleep(0.05)
        yield AIMessageChunk(content="", additional_kwargs={"reasoning_content": "PRIVATE-REASONING"})
        await asyncio.sleep(0.09)
        yield AIMessageChunk(content="Видимый ответ")

    agent.llm_talk.astream = stream

    async def run():
        trace = TurnTrace(None, None, agent.config)
        token = ACTIVE_TRACE.set(trace)
        try:
            chunks = [chunk async for chunk in astream_text_with_fallback(agent, [])]
            assert "".join(getattr(chunk, "content", "") or "" for chunk in chunks) == "Видимый ответ"
            assert trace.calls[0]["first_reasoning_ms"] is not None
            assert "PRIVATE-REASONING" not in json.dumps(trace.report())
        finally:
            ACTIVE_TRACE.reset(token)

    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_first_token_retry_stops_at_the_turn_budget(tmp_path):
    from core.agent.llm_stream import astream_text_with_fallback
    agent = offline_agent(tmp_path)
    agent.primary_first_token_timeout = 1
    agent.config["llm"]["talk_model"]["turn_timeout_seconds"] = 0.12

    async def stream(messages):
        await asyncio.Event().wait()
        yield AIMessageChunk(content="нет")

    agent.llm_talk.astream = stream

    async def run():
        trace = TurnTrace(None, None, agent.config)
        token = ACTIVE_TRACE.set(trace)
        started = time.monotonic()
        try:
            with pytest.raises(TimeoutError):
                async for _ in astream_text_with_fallback(agent, []):
                    pass
            assert time.monotonic() - started < 0.45
            assert len(trace.calls) == 1
        finally:
            ACTIVE_TRACE.reset(token)

    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_visible_reply_clip_uses_the_reply_budget_not_the_api_budget():
    from core.agent.reply_pipeline import clip_visible_reply
    assert clip_visible_reply("коротко", 20) == "коротко"
    clipped = clip_visible_reply("abcdefghij klmnop", 1)
    assert len(clipped) <= 4
    assert "klmnop" not in clipped
