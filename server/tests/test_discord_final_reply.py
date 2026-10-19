"""Discord sends completed chat replies without a draft, typing or edits."""

import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock

import discord
import pytest

from core.runtime.event_bus import NOTIFY_DISCORD_MESSAGE_SENT
from modules.discord.bot import NeyraDiscordBot, chunk_codeblock_message, chunk_message


def fixture_parts():
    agent = NS(chat=AsyncMock(side_effect=AssertionError('Preserve core stream retry semantics')), chat_stream=Mock(),
               identity=NS(resolve_from_discord=Mock(return_value='owner'), resolve_console=Mock()),
               event_bus=NS(publish=Mock()))
    channel = NS(send=AsyncMock(side_effect=[NS(id=i) for i in range(101, 130)]), typing=Mock())
    starter = NS(reply=AsyncMock(return_value=NS(id=100)), edit=AsyncMock())
    kwargs = dict(text_channel=channel, starter_message=starter, content='question',
                  username='handle', author_display_name='Display', discord_user_id='123',
                  channel_id_str='77', vision_images=[('image/png', 'offline')],
                  avatar_url='https://example.test/avatar', discord_context=object())
    return NS(agent=agent), channel, starter, kwargs


async def chunks(*items):
    for item in items:
        yield item


@pytest.mark.parametrize('with_starter', [False, True])
def test_no_discord_requests_until_chat_is_complete(with_starter):
    bot, channel, starter, kwargs = fixture_parts()
    if not with_starter:
        kwargs['starter_message'] = None
    async def run():
        started, ready = asyncio.Event(), asyncio.Event()
        closed = asyncio.Event()
        async def respond(*args, **kw):
            try:
                started.set()
                yield {'type': 'token', 'text': 'DRAFT-ONLY'}
                await ready.wait()
                yield {'type': 'done', 'text': 'Finished\\nanswer', 'raw': 'PRIVATE-RAW', 'thoughts': 'PRIVATE-THOUGHTS'}
            finally:
                closed.set()
        bot.agent.chat_stream.side_effect = respond
        task = asyncio.create_task(NeyraDiscordBot._run_chat_reply(bot, **kwargs))
        await started.wait()
        starter.reply.assert_not_awaited()
        channel.send.assert_not_awaited()
        channel.typing.assert_not_called()
        ready.set()
        await task
        assert closed.is_set()
        sent = starter.reply if with_starter else channel.send
        sent.assert_awaited_once()
        assert sent.call_args.args == ('Finished\nanswer',)
        if with_starter:
            assert sent.call_args.kwargs == {'mention_author': False}
            channel.send.assert_not_awaited()
        starter.edit.assert_not_awaited()
        bot.agent.chat.assert_not_awaited()
        expected = {key: value for key, value in kwargs.items() if key not in ('text_channel', 'starter_message', 'content', 'channel_id_str')}
        expected['channel_id'] = '77'
        bot.agent.chat_stream.assert_called_once_with('question', **expected)
        event = bot.agent.event_bus.publish.call_args.args[0]
        assert event.event_type == NOTIFY_DISCORD_MESSAGE_SENT
        assert event.payload == {'user_id': 'owner', 'channel_id': '77', 'message_ids': [100 if with_starter else 101], 'parts': 1}
    asyncio.run(run())


@pytest.mark.parametrize('lyrics', [False, True])
def test_long_completed_reply_preserves_parts_and_notification(lyrics):
    bot, channel, starter, kwargs = fixture_parts()
    text = ('Line of a complete answer.\n' * 180).strip()
    kwargs['lyrics_mode'] = lyrics
    bot.agent.chat_stream.return_value = chunks({'type': 'done', 'text': text})
    asyncio.run(NeyraDiscordBot._run_chat_reply(bot, **kwargs))
    expected = (chunk_codeblock_message if lyrics else chunk_message)(text, limit=1900)
    actual = [starter.reply.call_args.args[0], *[call.args[0] for call in channel.send.call_args_list]]
    assert actual == expected
    assert all(len(part) <= 1900 for part in actual)
    assert '▌' not in ''.join(actual)
    event = bot.agent.event_bus.publish.call_args.args[0]
    assert event.payload['message_ids'] == [100, *range(101, 100 + len(expected))]
    assert event.payload['parts'] == len(expected)
    starter.edit.assert_not_awaited()
    channel.typing.assert_not_called()


@pytest.mark.parametrize('failure', ['exception', 'error_chunk', 'public_error_chunk', 'unknown_code', 'missing_done'])
def test_generation_error_sends_one_safe_reply(failure):
    bot, channel, starter, kwargs = fixture_parts()
    if failure == 'exception':
        bot.agent.chat_stream.side_effect = RuntimeError('PRIVATE-UPSTREAM-DETAIL')
    elif failure in ('error_chunk', 'public_error_chunk', 'unknown_code'):
        bot.agent.chat_stream.return_value = chunks({
            'type': 'error', 'text': 'PRIVATE-UPSTREAM-DETAIL',
            'public': failure == 'public_error_chunk',
            'code': 'PRIVATE-UPSTREAM-DETAIL' if failure == 'unknown_code' else None,
        })
    else:
        bot.agent.chat_stream.return_value = chunks({'type': 'token', 'text': 'PRIVATE-UPSTREAM-DETAIL'})
    asyncio.run(NeyraDiscordBot._run_chat_reply(bot, **kwargs))
    starter.reply.assert_awaited_once()
    assert 'Не удалось подготовить ответ' in starter.reply.call_args.args[0]
    assert 'PRIVATE-UPSTREAM-DETAIL' not in str(starter.reply.call_args)
    starter.edit.assert_not_awaited()
    channel.send.assert_not_awaited()
    bot.agent.event_bus.publish.assert_not_called()


def test_brain_unavailable_uses_fixed_friendly_message():
    from core.agent.brain_phase import BRAIN_DOWN_USER_MESSAGE

    bot, channel, starter, kwargs = fixture_parts()
    bot.agent.chat_stream.return_value = chunks({
        'type': 'error', 'code': 'brain_unavailable', 'text': 'PRIVATE-UPSTREAM-DETAIL',
    })
    asyncio.run(NeyraDiscordBot._run_chat_reply(bot, **kwargs))
    starter.reply.assert_awaited_once_with(BRAIN_DOWN_USER_MESSAGE, mention_author=False)
    channel.send.assert_not_awaited()
    bot.agent.event_bus.publish.assert_not_called()


def test_cancellation_does_not_leave_a_draft_or_publish_sent_event():
    bot, channel, starter, kwargs = fixture_parts()
    async def run():
        started = asyncio.Event()
        async def respond(*args, **kw):
            started.set()
            yield {'type': 'token', 'text': 'DRAFT-ONLY'}
            await asyncio.Event().wait()
        bot.agent.chat_stream.side_effect = respond
        task = asyncio.create_task(NeyraDiscordBot._run_chat_reply(bot, **kwargs))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        starter.reply.assert_not_awaited()
        channel.send.assert_not_awaited()
        bot.agent.event_bus.publish.assert_not_called()
    asyncio.run(run())


def test_discord_send_failure_does_not_retry_or_publish_success():
    bot, channel, starter, kwargs = fixture_parts()
    bot.agent.chat_stream.return_value = chunks({'type': 'done', 'text': 'Finished answer'})
    starter.reply.side_effect = discord.HTTPException(NS(status=403, reason='Forbidden'), 'Missing permissions')
    asyncio.run(NeyraDiscordBot._run_chat_reply(bot, **kwargs))
    starter.reply.assert_awaited_once()
    channel.send.assert_not_awaited()
    starter.edit.assert_not_awaited()
    bot.agent.event_bus.publish.assert_not_called()


def test_real_core_context_retry_still_sends_only_one_final_reply(tmp_path):
    from offline_support import offline_agent
    agent = offline_agent(tmp_path)
    bot, channel, starter, kwargs = fixture_parts()
    bot.agent = agent
    kwargs.update(vision_images=None, discord_context=None)
    original = agent.llm_talk.astream
    attempts = []
    notifications = []
    agent.event_bus.subscribe(NOTIFY_DISCORD_MESSAGE_SENT, notifications.append)

    async def overflow_once(messages):
        attempts.append(messages)
        if len(attempts) == 1:
            raise RuntimeError('context_length_exceeded')
        async for item in original(messages):
            yield item
    agent.llm_talk.astream = overflow_once
    try:
        asyncio.run(NeyraDiscordBot._run_chat_reply(bot, **kwargs))
        assert len(attempts) == 2
        starter.reply.assert_awaited_once()
        assert 'Проверочный ответ' in starter.reply.call_args.args[0]
        starter.edit.assert_not_awaited()
        channel.send.assert_not_awaited()
        channel.typing.assert_not_called()
        assert len(notifications) == 1
        assert notifications[0].payload['message_ids'] == [100]
        assert agent.memory_hub.affect_for_account('123')['relation']['observed']
    finally:
        agent.memory_hub.close()
