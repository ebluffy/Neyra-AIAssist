import type { CharacterState } from './state';

const colors: Record<CharacterState, string> = { idle: '#7a8aa0', listening: '#50d3e9', thinking: '#e9c350', speaking: '#7be99a' };

/** Flat marker shown when no usable .vrm is selected. */
export function drawFallback(context: CanvasRenderingContext2D, state: CharacterState, mouth: number, time: number) {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  const bob = Math.sin(time / 600) * 4;
  context.fillStyle = colors[state];
  context.beginPath();
  context.arc(160, 260 + bob, 90, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#101722';
  context.fillRect(130, 240 + bob, 14, 14);
  context.fillRect(176, 240 + bob, 14, 14);
  context.fillRect(140, 290 + bob, 40, 4 + mouth * 18);
}
