import type { LiveState } from '../types';

export function VoiceOrb({ state, level, mini = false, pip = false }: { state: LiveState; level: number; mini?: boolean; pip?: boolean }) {
  const kind = pip ? 'orb pip' : mini ? 'orb mini' : 'orb';
  return <div className={kind} data-state={state} style={{ ['--level' as string]: String(Math.min(1, Math.max(0, level))) }} aria-hidden="true" />;
}
