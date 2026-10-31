import { listen } from '@tauri-apps/api/event';
import { type CharacterState, stateFromEvent } from './state';

// Placeholder renderer: no 3D engine is loaded yet. It proves the transparent
// window, event wiring and state mapping; VRM drawing replaces draw().
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const context = canvas.getContext('2d');
let state: CharacterState = 'idle';

void listen<{ type: string }>('desktop-event', ({ payload }) => {
  const next = stateFromEvent(payload.type);
  if (next) state = next;
});

const colors: Record<CharacterState, string> = { idle: '#7a8aa0', listening: '#50d3e9', thinking: '#e9c350', speaking: '#7be99a' };

function draw(time: number) {
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const bob = Math.sin(time / 600) * 4;
  context.fillStyle = colors[state];
  context.beginPath();
  context.arc(160, 260 + bob, 90, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#101722';
  context.fillRect(130, 240 + bob, 14, 14);
  context.fillRect(176, 240 + bob, 14, 14);
  const open = state === 'speaking' ? 6 + Math.abs(Math.sin(time / 120)) * 16 : 4;
  context.fillRect(140, 290 + bob, 40, open);
}

let last = 0;
function frame(time: number) {
  if (time - last >= 1000 / 30) { last = time; draw(time); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
