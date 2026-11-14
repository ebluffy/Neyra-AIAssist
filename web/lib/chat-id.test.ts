import { describe, expect, it } from 'vitest';
import {
  CHAT_ID_KEY,
  TAB_KEY,
  resolveChatId,
  resolveTabKey,
  resetChatId,
  clearChatId,
  buildChatStorageKey,
  type ChatIdStorage,
} from './chat-id';

function memoryStorage(): ChatIdStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: k => void data.delete(k),
  };
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
  it('keeps one thread id for the same conversation and user in one tab', () => {
    const storage = memoryStorage();
    const first = resolveChatId(storage, 'tab-1', 'u-1', () => 'id-1');
    const second = resolveChatId(storage, 'tab-1', 'u-1', () => 'id-2');
    expect(first).toBe('id-1');
    expect(second).toBe('id-1');
    expect(storage.data.get(`${CHAT_ID_KEY}:u-1:tab-1`)).toBe('id-1');
  });

  it('switches thread id when user changes in the same tab (AR-11)', () => {
    const storage = memoryStorage();
    const aliceChat = resolveChatId(storage, 'tab-1', 'alice', () => 'alice-id');
    const bobChat = resolveChatId(storage, 'tab-1', 'bob', () => 'bob-id');
    expect(aliceChat).toBe('alice-id');
    expect(bobChat).toBe('bob-id');
    expect(storage.data.get(buildChatStorageKey('alice', 'tab-1'))).toBe('alice-id');
    expect(storage.data.get(buildChatStorageKey('bob', 'tab-1'))).toBe('bob-id');
  });

  it('clears chat id upon logout / cleanup (AR-11)', () => {
    const storage = memoryStorage();
    resolveChatId(storage, 'tab-1', 'alice', () => 'alice-id');
    expect(storage.getItem(buildChatStorageKey('alice', 'tab-1'))).toBe('alice-id');
    clearChatId(storage, 'tab-1', 'alice');
    expect(storage.getItem(buildChatStorageKey('alice', 'tab-1'))).toBeNull();
  });

  it('resets thread id to a new one when requested (AR-12)', () => {
    const storage = memoryStorage();
    const oldId = resolveChatId(storage, 'tab-1', 'alice', () => 'old-id');
    expect(oldId).toBe('old-id');
    const newId = resetChatId(storage, 'tab-1', 'alice', () => 'new-id');
    expect(newId).toBe('new-id');
    expect(resolveChatId(storage, 'tab-1', 'alice', () => 'another-id')).toBe('new-id');
  });

  it('does not reuse another tab thread from copied sessionStorage', () => {
    const copied = memoryStorage();
    copied.setItem(`${CHAT_ID_KEY}:u-1:opener`, 'old-thread');
    expect(resolveChatId(copied, 'new-tab', 'u-1', () => 'fresh')).toBe('fresh');
  });

  it('makes a new id when nothing is saved', () => {
    expect(resolveChatId(memoryStorage(), 'tab-1', 'u-1', () => 'fresh')).toBe('fresh');
  });

  it('works without storage (server render)', () => {
    expect(resolveChatId(null, 'ssr', 'u-1', () => 'ssr')).toBe('ssr');
  });
});
