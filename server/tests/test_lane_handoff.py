"""Real offline turn pipeline: lane boundaries, continuity and persona delivery."""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage

from offline_support import OfflineModel, offline_agent


def block(messages, marker):
    for message in messages:
        if isinstance(message.content, str) and marker + '\n' in message.content:
            assert message.type == 'human'
            return json.loads(message.content.split(marker + '\n', 1)[1])
    return None


async def turn(agent, message, *, stream, user='123', channel='77'):
    kwargs = dict(discord_user_id=user, channel_id=channel, author_display_name='Same name')
    if stream:
        chunks = [chunk async for chunk in agent.chat_stream(message, **kwargs)]
        assert chunks[-1]['type'] == 'done'
        return chunks[-1]
    return await agent.chat(message, **kwargs)


@pytest.mark.parametrize('stream', [False, True])
def test_brain_sees_public_reply_and_current_state_without_persona_or_extra_pass(tmp_path, stream):
    agent = offline_agent(tmp_path)
    agent.config['assistant']['system_prompt'] = 'PERSONA-ONLY-TALK'
    agent.config['agent']['de_repeat'] = {'enabled': False}
    agent.config['memory']['diary_after_turn'] = True

    async def reply(messages):
        agent.llm_talk.messages.append(messages)
        return AIMessage(content='<think>PRIVATE-REASONING</think>PUBLIC-ANSWER')
    agent.llm_talk.ainvoke = reply

    async def run():
        first = await turn(agent, 'спасибо', stream=stream)
        assert first['text'] == 'PUBLIC-ANSWER'
        await asyncio.gather(*list(agent._background_jobs), return_exceptions=True)
        assert len(agent.llm_brain.messages) == 1
        assert 'PUBLIC-ANSWER' in str(agent.llm_memory.messages)
        assert 'PRIVATE-REASONING' not in str(agent.llm_memory.messages)
        await turn(agent, 'continue', stream=stream)
        assert len(agent.llm_brain.messages) == 2
        brain = agent.llm_brain.messages[-1]
        history = block(brain, '[RECENT DIALOGUE DATA]')
        assert history[-1] == {'role': 'assistant', 'content': 'PUBLIC-ANSWER'}
        assert 'PRIVATE-REASONING' not in str(history)
        talk = agent.llm_talk.messages[-1]
        assert block(brain, '[ASSISTANT STATE DATA]') == block(talk, '[ASSISTANT STATE DATA]')
        assert block(brain, '[ASSISTANT STATE DATA]')['relation']['familiarity'] > 0
        assert 'PERSONA-ONLY-TALK' not in str(brain)
        assert all('PERSONA-ONLY-TALK' in call[0].content for call in agent.llm_talk.messages)
        await asyncio.gather(*list(agent._background_jobs), return_exceptions=True)
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_brain_history_remains_scoped_by_account_and_channel(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config['agent']['de_repeat'] = {'enabled': False}
    async def run():
        await turn(agent, 'PRIVATE-FIRST-USER', stream=False)
        await turn(agent, 'other user', stream=False, user='456')
        assert block(agent.llm_brain.messages[-1], '[RECENT DIALOGUE DATA]') is None
        await turn(agent, 'other channel', stream=False, channel='88')
        assert block(agent.llm_brain.messages[-1], '[RECENT DIALOGUE DATA]') is None
        await turn(agent, 'return', stream=False)
        history = block(agent.llm_brain.messages[-1], '[RECENT DIALOGUE DATA]')
        assert 'PRIVATE-FIRST-USER' in str(history)
        assert 'other user' not in str(history)
        assert 'other channel' not in str(history)
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize('stream', [False, True])
def test_rewrite_preserves_original_persona_state_and_author_context(tmp_path, stream):
    agent = offline_agent(tmp_path)
    agent.config['assistant']['system_prompt'] = 'PERSONA-REWRITE'
    async def run():
        await turn(agent, 'спасибо', stream=stream)
        output = await turn(agent, 'same again', stream=stream)
        assert any(call['purpose'] == 'rewrite' for call in output['model_trace']['calls'])
        original, rewritten = agent.llm_talk.messages[-2:]
        assert rewritten[0].content == original[0].content
        assert str(rewritten).count('PERSONA-REWRITE') == 1
        assert block(rewritten, '[ASSISTANT STATE DATA]') == block(original, '[ASSISTANT STATE DATA]')
        assert block(rewritten, '[TURN CONTEXT DATA]') == block(original, '[TURN CONTEXT DATA]')
        assert len(agent.llm_brain.messages) == 2
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize('stream', [False, True])
@pytest.mark.parametrize('native', [False, True])
def test_vision_handoff_uses_only_configured_image_lane(tmp_path, stream, native):
    agent = offline_agent(tmp_path)
    agent.config['llm']['vision_model'].update(enabled=True, use_brain_model_for_vision=native)
    agent.llm_vision = agent.llm_brain if native else OfflineModel('vision')
    async def run():
        kwargs = dict(discord_user_id='123', channel_id='77', vision_images=[('image/png', 'offline-image')])
        if stream:
            result = [item async for item in agent.chat_stream('look', **kwargs)]
            output = result[-1]
        else:
            output = await agent.chat('look', **kwargs)
        calls = output['model_trace']['calls']
        assert len(agent.llm_brain.messages) == 1
        assert sum(call['lane'] == 'vision' for call in calls) == (0 if native else 1)
        brain = next(call for call in calls if call['lane'] == 'brain')
        assert brain['has_images'] is native
        if native:
            assert 'offline-image' in str(agent.llm_brain.messages)
        else:
            assert 'offline-image' in str(agent.llm_vision.messages)
            assert 'offline-image' not in str(agent.llm_brain.messages)
        assert '[BRAIN FACTS / TOOL RESULTS]' in str(agent.llm_talk.messages)
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_persona_file_reloaded_each_turn_and_preserved_after_overflow(tmp_path):
    agent = offline_agent(tmp_path)
    persona = tmp_path / 'persona.md'
    persona.write_text('PERSONA-OLD', encoding='utf-8')
    agent.config['assistant']['persona_path'] = 'persona.md'
    agent.config['agent']['de_repeat'] = {'enabled': False}
    original_stream = agent.llm_talk.astream
    attempts = []

    async def overflow_once(messages):
        attempts.append(messages)
        if len(attempts) == 1:
            raise RuntimeError('context_length_exceeded')
        async for chunk in original_stream(messages):
            yield chunk

    async def run():
        await turn(agent, 'first', stream=False)
        assert 'PERSONA-OLD' in agent.llm_talk.messages[0][0].content
        persona.write_text('PERSONA-NEW', encoding='utf-8')
        agent.llm_talk.astream = overflow_once
        await turn(agent, 'second', stream=True)
        assert len(attempts) == 2
        assert all('PERSONA-NEW' in call[0].content for call in attempts)
        assert all('PERSONA-OLD' not in call[0].content for call in attempts)
        assert block(attempts[0], '[ASSISTANT STATE DATA]') == block(attempts[1], '[ASSISTANT STATE DATA]')
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize('stream', [False, True])
@pytest.mark.parametrize('mode,rewritten', [
    ('tags', '[PLAN]PRIVATE-REWRITE-PLAN[/PLAN]Fresh answer'),
    ('tags', 'Fresh [PLAN]PRIVATE-REWRITE-PLAN[/PLAN]answer'),
    ('tags', 'Fresh answer[PLAN]PRIVATE-REWRITE-PLAN'),
    ('anchor', 'PLAN: PRIVATE-REWRITE-PLAN\nSAY: Fresh answer'),
])
def test_rewrite_drops_prefill_and_never_publishes_micro_plan(tmp_path, stream, mode, rewritten):
    from core.agent.micro_plan import MicroPlanSettings
    agent = offline_agent(tmp_path)
    agent.micro_planning_enabled = True
    agent._micro_plan_settings = lambda: MicroPlanSettings(True, mode, '[PLAN]', '[/PLAN]', 'PLAN:', 'SAY:', True)
    agent._micro_plan_metrics = dict.fromkeys(('filtered_stream_chars', 'filtered_final_chars', 'unclosed_blocks', 'leak_detected'), 0)
    agent.config['memory']['diary_after_turn'] = True

    async def respond(messages):
        agent.llm_talk.messages.append(messages)
        return AIMessage(content=rewritten if 'Duplicate candidate:' in str(messages[-1].content) else 'Repeated answer')
    agent.llm_talk.ainvoke = respond

    async def run():
        await turn(agent, 'first', stream=stream)
        output = await turn(agent, 'again', stream=stream)
        await asyncio.gather(*list(agent._background_jobs), return_exceptions=True)
        assert output['text'] == 'Fresh answer'
        original, rewrite = agent.llm_talk.messages[-2:]
        assert original[-1].type == 'ai'
        assert rewrite[-2].type == 'human'
        assert not any(message.type == 'ai' and message.content.strip() in ('[PLAN]', 'PLAN:') for message in rewrite)
        assert 'PRIVATE-REWRITE-PLAN' not in str(agent.memory_hub.list_chat(limit=10))
        assert 'PRIVATE-REWRITE-PLAN' not in str(agent.llm_memory.messages)
        assert 'PRIVATE-REWRITE-PLAN' not in str(agent.short_memory.windows())
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()
