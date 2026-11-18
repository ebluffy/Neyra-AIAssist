import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTokenBatch, TOKEN_BATCH_MS } from './streaming';

describe('streaming token batches', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes a thousand tokens in bounded batches without idle polling', () => {
    const publish = vi.fn();
    const batch = createTokenBatch(publish);
    expect(vi.getTimerCount()).toBe(0);
    let text = '';
    for (let i = 0; i < 1000; i += 1) {
      const token = `${i} `;
      text += token;
      batch.push(token);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    expect(publish).toHaveBeenCalledTimes(Math.ceil(1000 / TOKEN_BATCH_MS));
    expect(publish).toHaveBeenLastCalledWith(text);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(publish).toHaveBeenCalledTimes(Math.ceil(1000 / TOKEN_BATCH_MS));
  });

  it('discards a queued old response before starting the next one', () => {
    const publish = vi.fn();
    const batch = createTokenBatch(publish);
    batch.push('old');
    vi.advanceTimersByTime(TOKEN_BATCH_MS - 1);
    batch.reset();
    batch.push('new');
    vi.advanceTimersByTime(1);
    expect(publish.mock.calls).toEqual([['']]);
    vi.advanceTimersByTime(TOKEN_BATCH_MS - 1);
    expect(publish.mock.calls).toEqual([[''], ['new']]);
  });

  it('cancels pending work on cleanup and ignores empty tokens', () => {
    const publish = vi.fn();
    const batch = createTokenBatch(publish);
    batch.push('');
    expect(vi.getTimerCount()).toBe(0);
    batch.push('pending');
    batch.dispose();
    vi.runAllTimers();
    expect(publish).not.toHaveBeenCalled();
    batch.push('remounted');
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    expect(publish).toHaveBeenCalledExactlyOnceWith('remounted');
  });
});
