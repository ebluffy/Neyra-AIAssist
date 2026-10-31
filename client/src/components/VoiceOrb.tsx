import type { LiveState } from '../types';

export function VoiceOrb({ state, level, mini = false }: { state: LiveState; level: number; mini?: boolean }) {
  return <div className={mini ? 'orb mini' : 'orb'} data-state={state} style={{ ['--level' as string]: String(Math.min(1, Math.max(0, level))) }} aria-hidden="true" />;
}
