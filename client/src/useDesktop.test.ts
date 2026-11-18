import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from './types';
import { TOKEN_BATCH_MS } from './streaming';

// Run hook state/effect transitions without a WebView or a desktop connection.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: (() => void)[] = [];
  const next = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  const changed = (old: readonly unknown[] | undefined, deps: readonly unknown[]) => !old || deps.some((value, i) => !Object.is(value, old[i]));
  return {
    useState<T>(initial: T | (() => T)) {
      const slot = next();
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [slot.value as T, (value: T | ((previous: T) => T)) => {
        const result = typeof value === 'function' ? (value as (previous: T) => T)(slot.value as T) : value;
        if (!Object.is(result, slot.value)) { slot.value = result; dirty = true; }
      }] as const;
    },
    useRef<T>(initial: T) {
      const slot = next();
      slot.value ??= { current: initial };
      return slot.value;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = next();
      if (!changed(slot.deps, deps)) return;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; slot.deps = deps; });
    },
    useCallback<T>(callback: T, deps: readonly unknown[]) {
      const slot = next();
      if (changed(slot.deps, deps)) { slot.value = callback; slot.deps = deps; }
      return slot.value;
    },
    begin() { cursor = 0; dirty = false; },
    commit() { const pending = effects; effects = []; pending.forEach(effect => effect()); },
    dirty: () => dirty,
    cleanup() { slots.forEach(slot => slot.cleanup?.()); },
    reset() { slots.length = 0; effects = []; cursor = 0; dirty = false; },
  };
});
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: ServerEvent }) => void>() }));
vi.mock('react', () => hooks);
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, listener: (event: { payload: ServerEvent }) => void) => {
  bridge.listeners.set(name, listener);
  return () => bridge.listeners.delete(name);
}) }));
import { useDesktop } from './useDesktop';

describe('desktop streaming and history persistence', () => {
  let desktop: ReturnType<typeof useDesktop>;
  const DesktopProbe = () => { hooks.begin(); desktop = useDesktop(); hooks.commit(); };
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
      if (hooks.dirty()) DesktopProbe();
    }
  };
  const event = (payload: ServerEvent) => bridge.listeners.get('desktop-event')!({ payload });
  const saves = () => bridge.invoke.mock.calls.filter(([name]) => name === 'save_chats');

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    hooks.reset();
    bridge.listeners.clear();
    bridge.invoke.mockReset();
    bridge.invoke.mockImplementation(async (name: string) => {
      if (name === 'load_settings') return { settings: { profiles: [], theme: 'neyra' }, data_root: '/mock' };
      if (name === 'load_chats') return [];
      if (name === 'update_state') return { settings: { auto_check: false }, key_configured: false };
    });
    DesktopProbe();
    await settle();
    bridge.invoke.mockClear();
  });
  afterEach(async () => {
    hooks.cleanup();
    await Promise.resolve();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never rewrites chat history for partial token batches, but saves the completed answer', async () => {
    for (let i = 0; i < 1000; i += 1) event({ type: 'token', text: 'я' });
    await settle();
    expect(desktop.partial).toBe('');
    expect(saves()).toHaveLength(0);
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    await settle();
    expect(desktop.partial).toBe('я'.repeat(1000));
    expect(desktop.messages).toEqual([]);
    expect(saves()).toHaveLength(0);
    event({ type: 'done', text: 'окончательный ответ' });
    await settle();
    expect(desktop.partial).toBe('');
    expect(saves()).toHaveLength(1);
    expect(saves()[0][1].threads[0].messages.map((message: { content: string }) => message.content)).toEqual(['окончательный ответ']);
  });

  it.each(['done', 'cancelled', 'error', 'disconnected', 'listening'])('drops queued tokens on %s', async type => {
    event({ type: 'token', text: 'stale' });
    event({ type, text: type === 'done' ? 'final' : undefined });
    await settle();
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    await settle();
    expect(desktop.partial).toBe('');
    event({ type: 'token', text: 'next' });
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    await settle();
    expect(desktop.partial).toBe('next');
  });

  it('cancels deferred partial updates when the hook unmounts', async () => {
    event({ type: 'token', text: 'queued' });
    hooks.cleanup();
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    expect(hooks.dirty()).toBe(false);
    expect(saves()).toHaveLength(0);
  });
});
