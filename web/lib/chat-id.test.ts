import { describe, expect, it } from 'vitest';
import { CHAT_ID_KEY, TAB_KEY, resolveChatId, resolveTabKey, type ChatIdStorage } from './chat-id';

function memoryStorage(): ChatIdStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('tab key', () => {
  it('survives a reload (same window keeps its name)', () => {
    const win = { name: '' };
    expect(resolveTabKey(win, () => 'tab-1')).toBe('tab-1');
    expect(win.name).toBe(`${TAB_KEY}:tab-1`);
    expect(resolveTabKey(win, () => 'tab-2')).toBe('tab-1');
  });

  it('gives a newly opened window its own key even when it inherited storage', () => {
    const opener = { name: '' };
    const opened = { name: '' };
    const first = resolveTabKey(opener, () => 'tab-1');
    expect(resolveTabKey(opened, () => 'tab-2')).not.toBe(first);
  });
});

describe('chat id', () => {
  it('keeps one thread id for the same conversation in one tab', () => {
    const storage = memoryStorage();
    const first = resolveChatId(storage, 'tab-1', () => 'id-1');
    const second = resolveChatId(storage, 'tab-1', () => 'id-2');
    expect(first).toBe('id-1');
    expect(second).toBe('id-1');
    expect(storage.data.get(`${CHAT_ID_KEY}:tab-1`)).toBe('id-1');
  });

  it('does not reuse another tab thread from copied sessionStorage', () => {
    const copied = memoryStorage();
    copied.setItem(`${CHAT_ID_KEY}:opener`, 'old-thread');
    expect(resolveChatId(copied, 'new-tab', () => 'fresh')).toBe('fresh');
  });

  it('makes a new id when nothing is saved', () => {
    expect(resolveChatId(memoryStorage(), 'tab-1', () => 'fresh')).toBe('fresh');
  });

  it('works without storage (server render)', () => {
    expect(resolveChatId(null, 'ssr', () => 'ssr')).toBe('ssr');
  });
});
