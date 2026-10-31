export type CharacterState = 'idle' | 'listening' | 'thinking' | 'speaking';

export function stateFromEvent(type: string): CharacterState | undefined {
  switch (type) {
    case 'recording': return 'listening';
    case 'transcribing': return 'thinking';
    case 'speaking': return 'speaking';
    case 'cancelled': case 'error': case 'disconnected': return 'idle';
    default: return undefined;
  }
}
