import type { CharacterState } from './state';

const ring: Record<CharacterState, number> = { idle: 0.34, listening: 0.58, thinking: 0.72, speaking: 0.95 };

/** Same glowing sphere as the live voice orb, shown when no usable .vrm is selected. */
export function drawFallback(context: CanvasRenderingContext2D, state: CharacterState, mouth: number, time: number) {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bob = reduce ? 0 : Math.sin(time / 700) * 3;
  const x = 160;
  const y = 250 + bob;
  const radius = 78 + (state === 'speaking' ? mouth * 6 : 0);
  context.globalAlpha = ring[state] * 0.45;
  context.fillStyle = '#50d3e9';
  context.beginPath();
  context.arc(x, y, radius * 1.32, 0, Math.PI * 2);
  context.fill();
  const body = context.createRadialGradient(x - 22, y - 26, 8, x, y, radius);
  body.addColorStop(0, '#e7fcff');
  body.addColorStop(0.42, '#50d3e9');
  body.addColorStop(1, '#8b7cff');
  context.globalAlpha = state === 'idle' ? 0.92 : 1;
  context.fillStyle = body;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = ring[state];
  context.strokeStyle = '#50d3e9';
  context.lineWidth = 3;
  context.beginPath();
  context.arc(x, y, radius + 12, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 1;
}
