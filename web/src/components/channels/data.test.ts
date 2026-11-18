import { describe, expect, it } from 'vitest';
import { channelLabel, cleanMessageText, groupMessagesByTurn, type Message } from './data';

describe('history formatting', () => {
  it('strips the core author prefix and keeps the message', () => {
    expect(cleanMessageText('[author_id: 328884003958423552] [Пользователь ebluffy]: Привет')).toBe('Привет');
    expect(cleanMessageText('[author_id: 1] текст')).toBe('текст');
  });

  it('keeps plain text and does not return an empty message', () => {
    expect(cleanMessageText('Привет')).toBe('Привет');
    expect(cleanMessageText('[author_id: 1]')).toBe('[author_id: 1]');
  });

  it('labels web sessions instead of raw session ids', () => {
    expect(channelLabel('web:abc:def')).toBe('веб-чат');
    expect(channelLabel('1498032547970683112')).toBe('1498032547970683112');
    expect(channelLabel(null)).toBe('Канал неизвестен');
  });

  it('groups messages by turn_id, ignores model_trace, and marks unanswered turns', () => {
    const raw: Message[] = [
      {
        id: 1,
        turn_id: 'turn-1',
        role: 'user',
        ts: '2026-11-13T10:00:00Z',
        text: 'Вопрос 1',
        person_id: 'p1',
        display_name: 'Пользователь',
        discord_id: '123',
        discord_username: 'user1',
        channel_id: 'c1',
      },
      {
        id: 2,
        turn_id: 'turn-1',
        role: 'model_trace',
        ts: '2026-11-13T10:00:01Z',
        text: 'TRACE DATA',
        person_id: null,
        display_name: null,
        discord_id: null,
        discord_username: null,
        channel_id: 'c1',
      },
      {
        id: 3,
        turn_id: 'turn-1',
        role: 'assistant',
        ts: '2026-11-13T10:00:02Z',
        text: 'Ответ 1',
        person_id: null,
        display_name: 'Нейра',
        discord_id: null,
        discord_username: 'neyra',
        channel_id: 'c1',
      },
      {
        id: 4,
        turn_id: 'turn-2',
        role: 'user',
        ts: '2026-11-13T10:05:00Z',
        text: 'Вопрос 2 без ответа',
        person_id: 'p1',
        display_name: 'Пользователь',
        discord_id: '123',
        discord_username: 'user1',
        channel_id: 'c1',
      },
    ];

    const turns = groupMessagesByTurn(raw);
    expect(turns).toHaveLength(2);

    expect(turns[0].turn_id).toBe('turn-1');
    expect(turns[0].userMessages[0]?.text).toBe('Вопрос 1');
    expect(turns[0].assistantMessages).toHaveLength(1);
    expect(turns[0].assistantMessages[0].text).toBe('Ответ 1');
    // Ensure model_trace was excluded
    expect(turns[0].allMessages.some((m) => m.role === 'model_trace')).toBe(false);

    // Unanswered turn
    expect(turns[1].turn_id).toBe('turn-2');
    expect(turns[1].userMessages[0]?.text).toBe('Вопрос 2 без ответа');
    expect(turns[1].assistantMessages).toHaveLength(0);
  });
});
