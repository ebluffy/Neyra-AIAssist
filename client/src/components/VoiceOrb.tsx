import { memo } from 'react';
import type { LiveState } from '../types';

export const VoiceOrb = memo(function VoiceOrb({ state, level, mini = false, pip = false }: { state: LiveState; level: number; mini?: boolean; pip?: boolean }) {
  const kind = pip ? 'orb pip' : mini ? 'orb mini' : 'orb';
  const safe = Math.min(1, Math.max(0, level));
  return <div className={kind} data-state={state} style={{ ['--level' as string]: String(safe) }} aria-hidden="true" />;
});
