import { describe, expect, it } from 'vitest';
import { blinkWeight, lookTarget, nextBlinkDelay, poseFor } from './animation';

describe('idle animation', () => {
  it('blinks once and closes fully in the middle', () => {
    expect(blinkWeight(-1)).toBe(0);
    expect(blinkWeight(80)).toBeCloseTo(1, 1);
    expect(blinkWeight(161)).toBe(0);
  });
  it('waits 2.5 to 6 seconds between blinks', () => {
    expect(nextBlinkDelay(0)).toBe(2500);
    expect(nextBlinkDelay(1)).toBe(6000);
    expect(nextBlinkDelay(5)).toBe(6000);
  });
  it('differs by voice state', () => {
    expect(poseFor('listening', 0).headZ).not.toBe(0);
    expect(poseFor('thinking', 0).lookUp).toBeGreaterThan(0);
    expect(poseFor('idle', 0).headZ).toBe(0);
  });
  it('keeps the look-at target bounded and ignores bad input', () => {
    const far = lookTarget(50, -50);
    expect(far.x).toBe(1.5);
    expect(far.y).toBeCloseTo(2.1);
    expect(lookTarget(Number.NaN, Number.NaN)).toEqual({ x: 0, y: 1.3, z: 2 });
  });
});
