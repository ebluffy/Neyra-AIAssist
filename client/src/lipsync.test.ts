import { describe, expect, it } from 'vitest';
import { mouthAt, smoothMouth } from './lipsync';

describe('lip-sync playback', () => {
  const track = { startedAt: 1000, frameMs: 20, levels: [0, 128, 255] };
  it('reads the frame for the current time', () => {
    expect(mouthAt(track, 1000)).toBe(0);
    expect(mouthAt(track, 1025)).toBeCloseTo(128 / 255);
    expect(mouthAt(track, 1059)).toBe(1);
  });
  it('is closed before, after and without a track', () => {
    expect(mouthAt(track, 999)).toBe(0);
    expect(mouthAt(track, 1060)).toBe(0);
    expect(mouthAt(undefined, 1000)).toBe(0);
    expect(mouthAt({ ...track, frameMs: 0 }, 1010)).toBe(0);
  });
  it('opens faster than it closes', () => {
    expect(smoothMouth(0, 1)).toBeGreaterThan(1 - smoothMouth(1, 0));
  });
});
