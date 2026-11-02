import type { CharacterState } from './state';

export interface Pose { chestX: number; headX: number; headZ: number; lookUp: number }

const BLINK_MS = 160;

/** Eyelid weight 0..1 at `sinceStart` ms into a blink; 0 when no blink is running. */
export function blinkWeight(sinceStart: number): number {
  if (sinceStart < 0 || sinceStart > BLINK_MS) return 0;
  return Math.sin((sinceStart / BLINK_MS) * Math.PI);
}

export function nextBlinkDelay(random: number): number {
  return 2500 + Math.min(1, Math.max(0, random)) * 3500;
}

/** Small bone offsets (radians) for the current state at time `seconds`. */
export function poseFor(state: CharacterState, seconds: number): Pose {
  const breath = Math.sin(seconds * 1.6) * 0.02;
  switch (state) {
    case 'listening': return { chestX: breath, headX: 0.02, headZ: 0.1, lookUp: 0 };
    case 'thinking': return { chestX: breath, headX: -0.08, headZ: -0.06, lookUp: 0.5 };
    case 'speaking': return { chestX: breath * 1.5, headX: Math.sin(seconds * 3) * 0.03, headZ: 0, lookUp: 0 };
    default: return { chestX: breath, headX: 0, headZ: 0, lookUp: 0 };
  }
}

/** World position of the look-at target from a cursor offset in -1..1. */
export function lookTarget(x: number, y: number, lookUp = 0): { x: number; y: number; z: number } {
  const clamp = (v: number) => Math.min(1, Math.max(-1, Number.isFinite(v) ? v : 0));
  return { x: clamp(x) * 1.5, y: 1.3 - clamp(y) * 0.8 + lookUp, z: 2 };
}
