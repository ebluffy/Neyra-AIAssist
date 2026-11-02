import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type MouthTrack, mouthAt, smoothMouth } from '../lipsync';
import { drawFallback } from './fallback';
import type { Rig } from './renderer';
import { type CharacterState, stateFromEvent } from './state';

interface CharacterInfo { enabled: boolean; settings: { model: string | null; fps_limit: number } }

const canvas = document.getElementById('stage') as HTMLCanvasElement;
let state: CharacterState = 'idle';
let track: MouthTrack | undefined;
let mouth = 0;
let rig: Rig | undefined;

void listen<{ type: string }>('desktop-event', ({ payload }) => {
  const next = stateFromEvent(payload.type);
  if (next) { state = next; rig?.setState(next); }
});
void listen<{ frame_ms: number; levels: number[] }>('character-mouth', ({ payload }) => {
  track = { startedAt: performance.now(), frameMs: payload.frame_ms, levels: payload.levels };
});
void listen<{ x: number; y: number }>('character-cursor', ({ payload }) => rig?.setLook(payload.x, payload.y));
void listen<{ fps_limit: number }>('character-settings', ({ payload }) => {
  if (typeof payload.fps_limit === 'number') rig?.setFps(payload.fps_limit);
});

// Mouth is smoothed here so the 3D and the flat renderer share one source.
setInterval(() => {
  mouth = smoothMouth(mouth, state === 'speaking' ? mouthAt(track, performance.now()) : 0);
  rig?.setMouth(mouth);
}, 33);

function runFallback() {
  const context = canvas.getContext('2d');
  if (!context) return;
  const frame = (time: number) => { drawFallback(context, state, mouth, time); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}

async function start() {
  const info = await invoke<CharacterInfo>('character_state');
  if (!info.enabled || !info.settings.model) { runFallback(); return; }
  try {
    const bytes = await invoke<ArrayBuffer>('character_model_load', { name: info.settings.model });
    const { startVrm } = await import('./renderer');
    rig = await startVrm(canvas, bytes, info.settings.fps_limit);
    rig.setState(state);
  } catch {
    runFallback();
  }
}
void start();
