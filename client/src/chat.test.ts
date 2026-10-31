import { describe, expect, it } from 'vitest';
import { clock, composerSlot, daypart, sessionOrNew, switchThread, threadTitle, type ChatThread } from './chat';
import { themeId } from './theme';

describe('chat composer', () => {
  it('keeps the live button until there is text', () => {
    expect(composerSlot('')).toBe('live');
    expect(composerSlot('   ')).toBe('live');
    expect(composerSlot('привет')).toBe('send');
  });
  it('names a thread from the first thing the user said', () => {
    expect(threadTitle([])).toBe('Новый чат');
    expect(threadTitle([{ role: 'user', content: '  коротко  ' }])).toBe('коротко');
    expect(threadTitle([{ role: 'user', content: 'а'.repeat(50) }])).toHaveLength(43);
  });
  it('greets by the time of day', () => {
    expect(daypart(0)).toBe('Доброй ночи');
    expect(daypart(9)).toBe('Доброе утро');
    expect(daypart(14)).toBe('Добрый день');
    expect(daypart(20)).toBe('Добрый вечер');
    expect(daypart(23)).toBe('Доброй ночи');
  });
  it('formats a recording clock', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(9500)).toBe('0:10');
  });
});

describe('chat session', () => {
  it('does not store an empty session id', () => {
    const fresh = sessionOrNew('', []);
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
    const kept = '11111111-1111-4111-8111-111111111111';
    expect(sessionOrNew(undefined, [{ sessionId: kept }])).toBe(kept);
    expect(sessionOrNew(kept, [])).toBe(kept);
  });
});

describe('thread switch', () => {
  it('keeps an empty thread empty', () => {
    const filled: ChatThread = { id: 'a', title: 'A', sessionId: '11111111-1111-4111-8111-111111111111', updated: 1, messages: [{ id: 'm', role: 'user', content: 'секрет', kind: 'text' }] };
    const empty: ChatThread = { id: 'b', title: 'Новый чат', sessionId: '22222222-2222-4222-8222-222222222222', updated: 2, messages: [] };
    const next = switchThread([filled, empty], 'a', filled.messages, 'b');
    expect(next?.activeId).toBe('b');
    expect(next?.messages).toEqual([]);
    expect(next?.threads.find(thread => thread.id === 'b')?.messages).toEqual([]);
    expect(next?.threads.find(thread => thread.id === 'a')?.messages.map(message => message.content)).toEqual(['секрет']);
  });
});

describe('themes', () => {
  it('falls back to the Neyra theme', () => {
    expect(themeId('neyra')).toBe('neyra');
    expect(themeId('dark')).toBe('dark');
    expect(themeId('light')).toBe('light');
    expect(themeId('purple')).toBe('neyra');
    expect(themeId(undefined)).toBe('neyra');
  });
});
