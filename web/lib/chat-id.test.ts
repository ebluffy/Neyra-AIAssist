import { describe, expect, it } from 'vitest';
import { CHAT_ID_KEY, resolveChatId, type ChatIdStorage } from './chat-id';

function memoryStorage(): ChatIdStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('chat id', () => {
  it('keeps one thread id for the same conversation', () => {
    const storage = memoryStorage();
    const first = resolveChatId(storage, () => 'id-1');
    const second = resolveChatId(storage, () => 'id-2');
    expect(first).toBe('id-1');
    expect(second).toBe('id-1');
    expect(storage.data.get(CHAT_ID_KEY)).toBe('id-1');
  });

  it('makes a new id when nothing is saved', () => {
    expect(resolveChatId(memoryStorage(), () => 'fresh')).toBe('fresh');
  });

  it('works without storage (server render)', () => {
    expect(resolveChatId(null, () => 'ssr')).toBe('ssr');
  });
});
