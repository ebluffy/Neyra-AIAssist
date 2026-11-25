import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_MAX_CONCURRENT_STREAMS,
  CHAT_RATE_WINDOW_MS,
  CHAT_REQUESTS_PER_WINDOW,
  activeChatStreams,
  beginChatStream,
  checkChatRateLimit,
  endChatStream,
  resetChatLimitsForTests,
} from './chat-limits';

beforeEach(() => resetChatLimitsForTests());

describe('chat limits', () => {
  it('counts requests per user in a sliding minute window and reports retry time', () => {
    const now = 1_000_000;
    for (let i = 0; i < CHAT_REQUESTS_PER_WINDOW; i++) {
      expect(checkChatRateLimit('user-1', now + i).ok).toBe(true);
    }
    const blocked = checkChatRateLimit('user-1', now + CHAT_REQUESTS_PER_WINDOW);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // Другой пользователь не страдает от чужого счётчика.
    expect(checkChatRateLimit('user-2', now + CHAT_REQUESTS_PER_WINDOW).ok).toBe(true);
  });

  it('accepts again after the window passes', () => {
    const now = 2_000_000;
    for (let i = 0; i < CHAT_REQUESTS_PER_WINDOW; i++) checkChatRateLimit('user-1', now + i);
    expect(checkChatRateLimit('user-1', now + CHAT_RATE_WINDOW_MS + 1).ok).toBe(true);
  });

  it('limits simultaneous streams per user and frees the slot on end', () => {
    for (let i = 0; i < CHAT_MAX_CONCURRENT_STREAMS; i++) {
      expect(beginChatStream('user-1')).toBe(true);
    }
    expect(beginChatStream('user-1')).toBe(false);
    expect(activeChatStreams('user-1')).toBe(CHAT_MAX_CONCURRENT_STREAMS);
    endChatStream('user-1');
    expect(beginChatStream('user-1')).toBe(true);
    // Чужой пользователь получает свои слоты.
    expect(beginChatStream('user-2')).toBe(true);
  });
});
