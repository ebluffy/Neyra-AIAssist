"""Lane contract under empty responses, reduced context and mixed image owners."""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

from core.agent.micro_plan import MicroPlanSettings
from offline_support import OfflineModel, offline_agent


def context(messages, marker):
    for message in messages:
        if isinstance(message.content, str) and message.content.startswith(marker + "\n"):
            assert message.type == "human"
            return message.content.split("\n", 1)[1]
    return None


async def turn(agent, text, *, stream, user="123", channel="77", images=None):
    kwargs = dict(discord_user_id=user, channel_id=channel, vision_images=images)
    if stream:
        chunks = [item async for item in agent.chat_stream(text, **kwargs)]
        assert chunks[-1]["type"] == "done"
        return chunks[-1]
    return await agent.chat(text, **kwargs)


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("mode,raw", [
    ("tags", "[PLAN]PRIVATE-REASK[/PLAN]Verse one\n\nVerse two"),
    ("anchor", "PLAN: PRIVATE-REASK\nSAY: Verse one\n\nVerse two"),
])
def test_empty_retry_preserves_persona_and_never_stores_private_plan(tmp_path, stream, mode, raw):
    agent = offline_agent(tmp_path)
    agent.config["assistant"]["system_prompt"] = "PERSONA-EMPTY-RETRY"
    agent.config["agent"].update(conversation_mode="detailed", de_repeat={"enabled": False})
    agent.config["memory"]["diary_after_turn"] = True
    agent.micro_planning_enabled = True
    agent._micro_plan_settings = lambda: MicroPlanSettings(True, mode, "[PLAN]", "[/PLAN]", "PLAN:", "SAY:", True)
    agent._micro_plan_metrics = dict.fromkeys(("filtered_stream_chars", "filtered_final_chars", "unclosed_blocks", "leak_detected"), 0)
    responses = ["", raw]

    async def respond(messages):
        agent.llm_talk.messages.append(messages)
        return AIMessage(content=responses.pop(0))

    agent.llm_talk.ainvoke = respond

    async def run():
        result = await turn(agent, "write a verse", stream=stream)
        await asyncio.gather(*list(agent._background_jobs), return_exceptions=True)
        assert result["text"] == "Verse one\n\nVerse two"
        original, retry = agent.llm_talk.messages
        assert retry[0].content == original[0].content
        assert "PERSONA-EMPTY-RETRY" in retry[0].content
        assert retry[-1].type == "human"
        assert context(retry, "[ASSISTANT STATE DATA]") == context(original, "[ASSISTANT STATE DATA]")
        for value in (agent.short_memory.windows(), agent.memory_hub.list_chat(limit=10), agent.llm_memory.messages):
            assert "PRIVATE-REASK" not in str(value)
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize("native", [False, True])
def test_reduced_context_keeps_bounded_brain_visual_facts(tmp_path, native):
    agent = offline_agent(tmp_path)
    agent.config["assistant"]["system_prompt"] = "PERSONA-VISION-RETRY"
    agent.config["llm"]["vision_model"].update(enabled=True, use_brain_model_for_vision=native)
    agent.llm_vision = agent.llm_brain if native else OfflineModel("vision")
    agent.llm_talk.errors = [RuntimeError("context_length_exceeded")] * 2

    async def brain(messages):
        agent.llm_brain.messages.append(messages)
        return AIMessage(content="VISUAL-FACT: a red square. " + "x" * 4000)
    agent.llm_brain.ainvoke = brain
    try:
        result = asyncio.run(turn(agent, "What is in the image?", stream=True, images=[("image/png", "synthetic-pixels")]))
        assert result["text"]
        assert len(agent.llm_brain.messages) == 1
        original, _, retry = agent.llm_talk.messages
        facts = context(retry, "[BRAIN FACTS / TOOL RESULTS]")
        assert facts is not None and "VISUAL-FACT: a red square." in facts
        assert len(facts) <= 2000
        assert len(str(retry)) < len(str(original))
        assert "PERSONA-VISION-RETRY" in retry[0].content
        assert context(retry, "[ASSISTANT STATE DATA]") == context(original, "[ASSISTANT STATE DATA]")
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize("stream", [False, True])
def test_previous_image_note_is_owner_scoped_and_reset_is_targeted(tmp_path, stream):
    agent = offline_agent(tmp_path)
    agent.config["agent"]["de_repeat"] = {"enabled": False}
    agent.config["llm"]["vision_model"].update(enabled=True, use_brain_model_for_vision=False)
    agent.llm_vision = OfflineModel("vision")

    async def respond(messages):
        agent.llm_talk.messages.append(messages)
        return AIMessage(content="IMAGE-A" if len(agent.llm_talk.messages) == 1 else "IMAGE-B")
    agent.llm_talk.ainvoke = respond

    def previous_image():
        talk = json.loads(context(agent.llm_talk.messages[-1], "[TURN CONTEXT DATA]"))["last_img_ctx"]
        brain = json.loads(context(agent.llm_brain.messages[-1], "[TURN CONTEXT DATA]").split("\n\n[ASSISTANT STATE DATA]", 1)[0])["last_img_ctx"]
        assert talk == brain
        return talk

    async def run():
        await turn(agent, "look", stream=stream, images=[("image/png", "pixels-a")])
        await turn(agent, "look", stream=stream, user="456", images=[("image/png", "pixels-b")])
        await turn(agent, "continue", stream=stream)
        assert "IMAGE-A" in previous_image() and "IMAGE-B" not in previous_image()
        await turn(agent, "elsewhere", stream=stream, channel="88")
        assert not previous_image()
        owner = agent.identity.resolve_from_discord("123")
        agent.reset_context("77", user_id=owner)
        await turn(agent, "continue", stream=stream, user="456")
        assert "IMAGE-B" in previous_image()
        await turn(agent, "continue", stream=stream)
        assert not previous_image()
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize("stream", [False, True])
def test_brain_keeps_observed_tool_results_when_step_budget_is_exhausted(tmp_path, stream):
    from unittest.mock import AsyncMock

    agent = offline_agent(tmp_path)
    agent.config["mcp_client"] = {"llm_tool_calls": True, "llm_tool_max_steps": 1}
    agent.tools = {"lookup": object()}
    agent._execute_tool = AsyncMock(return_value="OBSERVED-TOOL-FACT")

    async def brain(messages):
        agent.llm_brain.messages.append(messages)
        return AIMessage(content="<think>PRIVATE-TOOL-REASONING</think>", tool_calls=[{
            "id": "offline-tool-call", "name": "lookup", "args": {}, "type": "tool_call",
        }])
    agent.llm_brain.ainvoke = brain
    try:
        asyncio.run(turn(agent, "look up a fact", stream=stream))
        facts = context(agent.llm_talk.messages[-1], "[BRAIN FACTS / TOOL RESULTS]")
        assert facts is not None and "OBSERVED-TOOL-FACT" in facts
        assert "PRIVATE-TOOL-REASONING" not in facts
        assert "OBSERVED-TOOL-FACT" not in agent.llm_talk.messages[-1][0].content
        assert len(agent.llm_brain.messages) == 1
        agent._execute_tool.assert_awaited_once_with("lookup")
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("tools_enabled", [False, True])
def test_brain_explicit_reasoning_is_not_forwarded_as_talk_context(tmp_path, stream, tools_enabled):
    agent = offline_agent(tmp_path)
    agent.config["mcp_client"] = {"llm_tool_calls": tools_enabled}
    agent.tools = {"unused": object()}

    async def brain(messages):
        agent.llm_brain.messages.append(messages)
        return AIMessage(content="<think>PRIVATE-BRAIN-REASONING</think>OBSERVED-BRAIN-FACT")
    agent.llm_brain.ainvoke = brain
    try:
        asyncio.run(turn(agent, "answer from facts", stream=stream))
        facts = context(agent.llm_talk.messages[-1], "[BRAIN FACTS / TOOL RESULTS]")
        assert facts == "OBSERVED-BRAIN-FACT"
        assert "PRIVATE-BRAIN-REASONING" not in str(agent.llm_talk.messages)
    finally:
        agent.memory_hub.close()


def test_stm_wipe_also_clears_scoped_image_notes(tmp_path):
    from unittest.mock import AsyncMock, MagicMock
    from fastapi.testclient import TestClient
    from core.api.app import build_app

    agent = offline_agent(tmp_path)
    try:
        asyncio.run(turn(agent, "look", stream=False, images=[("image/png", "synthetic-pixels")]))
        assert agent._last_vision_note_by_scope
        app = build_app(
            agent.config, shared_agent=agent, project_root=tmp_path,
            shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
            shared_backup_manager=MagicMock(),
        )
        with TestClient(app) as client:
            response = client.post("/v1/memory/wipe", json={"scopes": ["stm"], "confirm": "WIPE"},
                                   headers={"Authorization": "Bearer offline-admin-token"})
            assert response.status_code == 200
            assert response.json()["data"]["deleted"]["stm"] == 1
        assert not agent._last_vision_note_by_scope
        assert not agent.short_memory.windows()
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize('prefix', ['<think>private', '[PLAN]private'])
@pytest.mark.parametrize('error', [RuntimeError('broken transport'), TimeoutError('midstream timeout')])
def test_retry_hidden_only_stream_resets_filters_and_history(tmp_path, prefix, error):
    agent = offline_agent(tmp_path)
    agent.config['agent']['de_repeat'] = {'enabled': False}
    agent._micro_plan_settings = lambda: MicroPlanSettings(True, 'tags', '[PLAN]', '[/PLAN]', 'PLAN:', 'SAY:', False)
    calls = []
    async def stream(messages):
        calls.append(messages)
        if len(calls) == 1:
            yield AIMessageChunk(content=prefix)
            raise error
        yield AIMessageChunk(content='Public recovered reply.')
    agent.llm_talk.astream = stream
    async def run():
        chunks = [c async for c in agent.chat_stream('hello', discord_user_id='123', channel_id='77')]
        assert chunks[-1]['type'] == 'done'
        assert ''.join(c['text'] for c in chunks if c['type'] == 'token') == 'Public recovered reply.'
        assert 'private' not in chunks[-1]['raw']
        assert 'private' not in str(agent.short_memory.windows())
        talk_calls = [c for c in chunks[-1]['model_trace']['calls'] if c['lane'] == 'talk']
        assert [c['status'] for c in talk_calls] == ['failed', 'completed']
    asyncio.run(run())
    assert len(calls) == 2
    agent.memory_hub.close()
