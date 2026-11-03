import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { GearMenu } from './components/GearMenu';
import { ServerPanel } from './components/ServerPanel';
import { Composer } from './components/Composer';
import { defaultVoice, type Settings } from './types';
import { useDesktop } from './useDesktop';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, callback) => {
  ipc.listeners.set(name, callback);
  return () => ipc.listeners.delete(name);
}) }));

let app: ReturnType<typeof useDesktop>;
function Harness() {
  const current = useDesktop();
  useEffect(() => { app = current; });
  return <span>{current.connected ? 'Подключено' : 'Нет связи'}</span>;
}
let root: ReactTestRenderer;
const settings: Settings = {
  profiles: [{ id: 'test', name: 'Test', url: 'http://localhost:8765', session_id: '11111111-1111-4111-8111-111111111111' }], active_profile: 'test',
  schema_version: 1, device_id: 'test', device_name: 'Test', theme: 'dark', voice: defaultVoice, graphics_mode: 'auto', audit_days: 7,
  permissions: { enabled: false, apps: [], allow_web: false, web_domains: [], system: false, shell: false, files: false, fs_roots: [], screen: false, screen_auto: false, input: false },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', { documentElement: { dataset: {} }, getElementById: () => null });
  ipc.listeners.clear();
  ipc.invoke.mockReset().mockImplementation(async (command: string, args?: { settings?: unknown }) => {
      if (command === 'load_settings') return { settings, data_root: '', global_shortcuts: false, pc_access_available: false };
    if (command === 'save_settings') return args?.settings;
    if (command === 'list_chats') return [];
    if (command === 'pc_capabilities') return { available: false };
    return {};
  });
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function mount() { await act(async () => { root = create(<Harness />); }); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mountApplication() {
  await act(async () => { root = create(<App />); });
  await act(async () => { root.root.findByType(GearMenu).props.onSettings('server'); });
}
function expectVisibleOffline() {
  expect(root.root.findByProps({ className: 'dot' }).props['data-on']).toBe('false');
  expect(root.root.findByProps({ className: 'offline' }).findByType('p').children.join('')).toContain('Нет связи');
  const connectButton = root.root.findAllByType('button').find(node => node.children.includes('Подключить'));
  expect(connectButton).toBeDefined();
  expect(connectButton?.props.disabled).toBe(false);
  expect(root.root.findAll(node => typeof node.props.className === 'string' && node.props.className.split(' ').includes('is-streaming'))).toHaveLength(0);
}

describe('unavailable server', () => {
  it.each(['connection refused', 'timeout', 'HTTP 503'])('shows offline and bounds retries for %s, then recovers', async reason => {
    const base = ipc.invoke.getMockImplementation()!;
    let available = false;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect' && !available) throw new Error(reason);
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    expect(root.toJSON()).toMatchObject({ children: ['Нет связи'] });
    expect(app.error).toContain('Нет связи');
    expect(app.busy).toBe(false);
    const attempts = () => ipc.invoke.mock.calls.filter(([command]) => command === 'connect').length;
    expect(attempts()).toBe(1);
    await tick(999); expect(attempts()).toBe(1);
    await tick(1); expect(attempts()).toBe(2);
    for (const delay of [2000, 4000, 8000, 16000, 30000]) await tick(delay);
    expect(attempts()).toBe(7);
    await tick(29999); expect(attempts()).toBe(7);
    available = true;
    await tick(1);
    expect(app.connected).toBe(true);
    expect(app.busy).toBe(false);
    expect(app.error).toBe('');
    await tick(120000); expect(attempts()).toBe(8);
  });

  it('clears a pending response on WSS loss and reconnects without replaying messages', async () => {
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    await act(async () => { await app.sendContent('hello'); });
    expect(app.thinking).toBe(true);
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type: 'disconnected' } }); });
    expect(app.connected).toBe(false);
    expect(app.thinking).toBe(false);
    expect(app.notice).toContain('Нет связи');
    expect(app.messages[0].content).toBe('hello');
    await tick(1000);
    expect(app.connected).toBe(true);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'chat')).toHaveLength(1);
    await act(async () => { await app.disconnect(); });
    await tick(120000);
    expect(app.connected).toBe(false);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(2);
  });

  it('keeps failed message text and explains retry, without a pending spinner', async () => {
    await mount();
    ipc.invoke.mockRejectedValueOnce(new Error('connection refused'));
    await act(async () => { app.setText('keep this'); });
    await act(async () => { await app.sendContent('keep this'); });
    expect(app.text).toBe('keep this');
    expect(app.error).toContain('Сообщение не отправлено');
    expect(app.error).toContain('Повторите');
    expect(app.thinking).toBe(false);
    expect(app.busy).toBe(false);
    expect(app.messages).toHaveLength(0);
  });

  it('renders the offline state in the application', async () => {
    await act(async () => { root = create(<App />); });
    expect(JSON.stringify(root.toJSON())).toContain('Нет связи');
  });

  it.each(['connection refused', 'timeout', 'HTTP 503'])('renders usable offline UI after %s', async reason => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect') throw new Error(reason);
      return base(command, args);
    });
    await mountApplication();
    await act(async () => { await root.root.findByType(ServerPanel).props.onConnect(); });
    await tick(0);
    expectVisibleOffline();
    expect(root.root.findByProps({ role: 'alert' }).children.join('')).toContain('Нет связи');
    await tick(1000);
    expectVisibleOffline();
  });

  it('renders offline and removes the response spinner after WSS close, including failed reconnect', async () => {
    await mountApplication();
    await act(async () => { await root.root.findByType(ServerPanel).props.onConnect(); });
    await tick(0);
    expect(root.root.findByProps({ className: 'dot' }).props['aria-label']).toBe('Подключено');
    await act(async () => { root.root.findByType(Composer).props.onText('hello'); });
    await act(async () => { await root.root.findByType(Composer).props.onSend(); });
    expect(root.root.findAllByProps({ className: 'msg assistant is-streaming' })).toHaveLength(1);
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect') throw new Error('connection refused');
      return base(command, args);
    });
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type: 'disconnected' } }); });
    expectVisibleOffline();
    expect(JSON.stringify(root.toJSON())).toContain('hello');
    await tick(1000);
    expectVisibleOffline();
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'chat')).toHaveLength(1);
  });

  it('keeps an in-flight connection when profile settings are edited', async () => {
    const base = ipc.invoke.getMockImplementation()!;
    let complete!: () => void;
    ipc.invoke.mockImplementation((command, args) => command === 'connect' ? new Promise<void>(resolve => { complete = resolve; }) : base(command, args));
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    await act(async () => { app.patchProfile({ name: 'Edited', url: 'http://localhost:9999' }); });
    await act(async () => { complete(); });
    expect(app.connected).toBe(true);
    await tick(120000);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(1);
  });

  it('does not connect to a selected profile during backoff without a new command', async () => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect') throw 'unavailable';
      return base(command, args);
    });
    await mount();
    await act(async () => { app.setSettings({ ...settings, profiles: [...settings.profiles, { ...settings.profiles[0], id: 'other' }] }); });
    await act(async () => { await app.connect(); });
    await tick(0);
    await act(async () => { app.chooseProfile('other'); });
    await tick(120000);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(1);
    expect(app.connected).toBe(false);
    await act(async () => { await app.connect(); });
    await tick(0);
    expect(ipc.invoke).toHaveBeenLastCalledWith('connect', { profileId: 'other' });
  });

  it('stops retries when a newly added profile becomes selected', async () => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect') throw 'connection refused';
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    await act(async () => { app.addProfile({ ...settings.profiles[0], id: 'added' }); });
    await tick(120000);
    expect(app.profileId).toBe('added');
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(1);
  });

  it.each(['Сначала сохраните токен', 'Профиль не найден', 'Неверный адрес сервера', 'Удалённый сервер требует HTTPS', 'Неверный токен', 'Системное хранилище секретов недоступно'])('stops automatic retries after configuration error: %s', async message => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect') throw `CONFIG_ERROR: ${message}`;
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    expect(app.connected).toBe(false);
    expect(app.busy).toBe(false);
    expect(app.error).toBe(message);
    await tick(120000);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(1);
    ipc.invoke.mockImplementation(base);
    await act(async () => { await app.connect(); });
    await tick(0);
    expect(app.connected).toBe(true);
    expect(app.error).toBe('');
  });

  it.each(['handshake', 'revoked'])('stops automatic retries after auth rejection: %s', async mode => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect' && mode === 'handshake') throw 'AUTH_REJECTED';
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    if (mode === 'revoked') await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type: 'disconnected', reason: 'auth' } }); });
    expect(app.connected).toBe(false);
    expect(app.error).toContain('Токен отклонён или отозван');
    await tick(120000);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(1);
    ipc.invoke.mockImplementation(base);
    const replacement = ['fleet', 'test', '48'].join('-');
    await act(async () => { app.setToken(replacement); });
    await act(async () => { await app.connect(); });
    await tick(0);
    expect(app.connected).toBe(true);
    expect(ipc.invoke).toHaveBeenCalledWith('store_token', { profileId: 'test', token: replacement });
  });

  it.each(['history', 'devices'])('keeps the connection when the initial %s request fails', async kind => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'bridge_message' && args?.kind === kind) throw 'failed';
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    expect(app.connected).toBe(true);
    expect(app.error).toContain(kind === 'history' ? 'Не удалось загрузить историю' : 'Не удалось загрузить список устройств');
    expect(ipc.invoke).toHaveBeenCalledWith('bridge_message', { kind: 'devices' });
    await tick(120000);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(1);
  });

  it('stops retrying after an explicit disconnect', async () => {
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    await act(async () => { await app.disconnect(); });
    const attempts = ipc.invoke.mock.calls.filter(([command]) => command === 'connect').length;
    await tick(120000);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(attempts);
  });
});
