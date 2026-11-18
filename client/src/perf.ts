import { invoke } from '@tauri-apps/api/core';

declare global {
  interface Window { __NEYRA_PERF__?: boolean }
}

type Stage = 'webview_ready' | 'first_render';

export function startupPerf(enabled: boolean, mark: (stage: Stage) => Promise<unknown> = stage => invoke('perf_mark', { stage })) {
  if (!enabled) return undefined;
  const ready = mark('webview_ready').catch(() => undefined);
  let rendered = false;
  return () => {
    if (rendered) return undefined;
    // The second frame allows the committed React tree a paint opportunity.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        rendered = true;
        void ready.then(() => mark('first_render')).catch(() => undefined);
      });
    });
    return () => cancelAnimationFrame(frame);
  };
}
