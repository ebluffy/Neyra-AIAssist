import { describe, expect, it } from 'vitest';
import { mouthTarget, parseWav16, rms, smoothMouth, wavMouthFrames } from './lipsync';

function wav(samples: number[], sampleRate = 16000): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (at: number, text: string) => [...text].forEach((c, i) => bytes.set([c.charCodeAt(0)], at + i));
  put(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, s, true));
  return bytes;
}

describe('lip-sync amplitude', () => {
  it('is zero for silence and bounded for loud audio', () => {
    expect(mouthTarget(rms([0, 0, 0]))).toBe(0);
    expect(mouthTarget(1)).toBe(1);
    expect(mouthTarget(Number.NaN)).toBe(0);
    expect(rms([])).toBe(0);
  });
  it('opens faster than it closes', () => {
    expect(smoothMouth(0, 1)).toBeGreaterThan(1 - smoothMouth(1, 0));
  });
  it('rejects non-PCM16 and truncated files', () => {
    expect(parseWav16(new Uint8Array(10))).toBeUndefined();
    const bad = wav([1, 2, 3]);
    bad[20] = 3;
    expect(parseWav16(bad)).toBeUndefined();
  });
  it('turns a WAV into per-frame mouth values', () => {
    const loud = Array.from({ length: 1600 }, (_, i) => (i % 2 ? 12000 : -12000));
    const quiet = new Array(1600).fill(0);
    const frames = wavMouthFrames(wav([...loud, ...quiet]), 10);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBeGreaterThan(0.3);
    expect(frames[1]).toBeLessThan(frames[0]);
    expect(wavMouthFrames(new Uint8Array(4), 10)).toEqual([]);
  });
});
