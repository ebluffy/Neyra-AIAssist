export const MOUTH_NOISE_FLOOR = 0.02;
export const MOUTH_FULL_SCALE = 0.25;

export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function mouthTarget(level: number): number {
  if (!Number.isFinite(level) || level <= MOUTH_NOISE_FLOOR) return 0;
  return Math.min(1, (level - MOUTH_NOISE_FLOOR) / (MOUTH_FULL_SCALE - MOUTH_NOISE_FLOOR));
}

export function smoothMouth(previous: number, target: number, attack = 0.6, release = 0.2): number {
  const rate = target > previous ? attack : release;
  return previous + (target - previous) * rate;
}

export interface WavInfo { sampleRate: number; channels: number; data: Int16Array }

export function parseWav16(bytes: Uint8Array): WavInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let at = 12;
  let sampleRate = 0;
  let channels = 0;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === 'fmt ' && size >= 16) {
      if (view.getUint16(body, true) !== 1 || view.getUint16(body + 14, true) !== 16) return undefined;
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
    } else if (tag(at) === 'data' && sampleRate > 0 && channels > 0) {
      const end = Math.min(bytes.length, body + size);
      const count = Math.floor((end - body) / 2);
      const data = new Int16Array(count);
      for (let i = 0; i < count; i++) data[i] = view.getInt16(body + i * 2, true);
      return { sampleRate, channels, data };
    }
    at = body + size + (size % 2);
  }
  return undefined;
}

export function wavMouthFrames(bytes: Uint8Array, fps: number): number[] {
  const wav = parseWav16(bytes);
  if (!wav || fps <= 0) return [];
  const perFrame = Math.max(1, Math.floor((wav.sampleRate * wav.channels) / fps));
  const frames: number[] = [];
  let mouth = 0;
  for (let at = 0; at < wav.data.length; at += perFrame) {
    const chunk = Array.from(wav.data.subarray(at, at + perFrame), v => v / 32768);
    mouth = smoothMouth(mouth, mouthTarget(rms(chunk)));
    frames.push(mouth);
  }
  return frames;
}
