export interface MouthTrack { startedAt: number; frameMs: number; levels: ArrayLike<number> }

export function smoothMouth(previous: number, target: number, attack = 0.6, release = 0.2): number {
  const rate = target > previous ? attack : release;
  return previous + (target - previous) * rate;
}

/** Mouth target 0..1 for `now` (ms) from a Rust-computed track, 0 outside it. */
export function mouthAt(track: MouthTrack | undefined, now: number): number {
  if (!track || track.frameMs <= 0 || now < track.startedAt) return 0;
  const index = Math.floor((now - track.startedAt) / track.frameMs);
  if (index >= track.levels.length) return 0;
  return Math.min(1, Math.max(0, track.levels[index] / 255));
}
