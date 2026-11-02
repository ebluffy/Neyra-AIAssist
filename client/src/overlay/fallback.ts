import type { ThemeId } from '../theme';
import type { CharacterState } from './state';

const ring: Record<CharacterState, number> = { idle: 0.34, listening: 0.58, thinking: 0.72, speaking: 0.95 };
const palettes: Record<ThemeId, { hi: string; mid: string; lo: string }> = {
  neyra: { hi: '#e7fcff', mid: '#50d3e9', lo: '#8b7cff' },
  dark: { hi: '#f6ead8', mid: '#c6a27a', lo: '#6a4b34' },
  light: { hi: '#e7fbff', mid: '#1a8c9a', lo: '#24315f' },
};

/** Same glowing sphere as the live voice orb, shown when no usable .vrm is selected. */
export function drawFallback(context: CanvasRenderingContext2D, state: CharacterState, mouth: number, time: number, theme: ThemeId = 'neyra') {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bob = reduce ? 0 : Math.sin(time / 700) * 3;
  const level = state === 'speaking' ? mouth : 0;
  const radius = reduce ? 78 : 78 + level * 6;
  const x = 160;
  const y = 250 + bob;
  const palette = palettes[theme];
  context.globalAlpha = ring[state] * 0.45;
  context.fillStyle = palette.mid;
  context.beginPath();
  context.arc(x, y, radius * 1.32, 0, Math.PI * 2);
  context.fill();
  const body = context.createRadialGradient(x - 22, y - 26, 8, x, y, radius);
  body.addColorStop(0, palette.hi);
  body.addColorStop(0.42, palette.mid);
  body.addColorStop(1, palette.lo);
  context.globalAlpha = reduce ? 0.55 + level * 0.45 : (state === 'idle' ? 0.92 : 1);
  context.fillStyle = body;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = ring[state];
  context.strokeStyle = palette.mid;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(x, y, radius + 12, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 1;
}
