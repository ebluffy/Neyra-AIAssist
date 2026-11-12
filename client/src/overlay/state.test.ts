import { describe, expect, it } from 'vitest';
import { stateFromEvent } from './state';

describe('character state from desktop events', () => {
  it('follows the voice mode', () => {
    expect(stateFromEvent('recording')).toBe('listening');
    expect(stateFromEvent('transcribing')).toBe('thinking');
    expect(stateFromEvent('speaking')).toBe('speaking');
  });
  it('returns to idle on stop, error and disconnect', () => {
    for (const type of ['audio.finished', 'cancelled', 'error', 'disconnected']) expect(stateFromEvent(type)).toBe('idle');
  });
  it('ignores unrelated events', () => { expect(stateFromEvent('chat')).toBeUndefined(); });
});
