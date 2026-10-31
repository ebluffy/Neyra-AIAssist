import type { LiveState } from '../types';

export function VoiceOrb({ state, level }: { state: LiveState; level: number }) {
  return <div className="orb" data-state={state} style={{ ['--level' as string]: String(Math.min(1, Math.max(0, level))) }} aria-hidden="true" />;
}
