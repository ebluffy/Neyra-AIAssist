import { afterEach, describe, expect, it, vi } from 'vitest';
import { startupPerf } from './perf';

afterEach(() => vi.unstubAllGlobals());

describe('opt-in startup marks', () => {
  it('does no IPC or scheduling when disabled', () => {
    const mark = vi.fn();
    const schedule = vi.fn();
    vi.stubGlobal('requestAnimationFrame', schedule);
    expect(startupPerf(false, mark)).toBeUndefined();
    expect(mark).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('records ready then a single committed render after a paint opportunity', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
    const tick = () => { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(0)); };
    const mark = vi.fn().mockResolvedValue(undefined);
    const render = startupPerf(true, mark)!;
    expect(mark.mock.calls).toEqual([['webview_ready']]);
    render()?.(); // StrictMode cleanup cancels the first mount.
    tick();
    expect(mark).toHaveBeenCalledTimes(1);
    render();
    tick();
    expect(mark).toHaveBeenCalledTimes(1);
    tick();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mark.mock.calls).toEqual([['webview_ready'], ['first_render']]);
    expect(render()).toBeUndefined();
  });

  it('keeps instrumentation failures out of UI error handling', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const mark = vi.fn().mockRejectedValue(new Error('unavailable'));
    startupPerf(true, mark)!();
    frames.shift()!(0);
    frames.shift()!(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mark.mock.calls).toEqual([['webview_ready'], ['first_render']]);
  });
});
