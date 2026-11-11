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
    if (command === 'chat_epoch') return 0;
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

  it('requests and reconciles server history after auto-reconnect with local A and answer', async () => {
    const base = ipc.invoke.getMockImplementation()!;
    let serverRows: Record<string, unknown>[] = [];
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'bridge_message' && args?.kind === 'history') {
        ipc.listeners.get('desktop-event')!({ payload: { type: 'history', messages: serverRows } });
      }
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    await act(async () => { await app.sendContent('A'); });
    const request = ipc.invoke.mock.calls.find(([command]) => command === 'chat')![1].requestId;
    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'done', source: 'bridge', request_id: request, text: 'answer' } });
    });
    const localIds = app.messages.map(row => row.id);
    const historyCalls = () => ipc.invoke.mock.calls.filter(([command, args]) => command === 'bridge_message' && args?.kind === 'history').length;
    expect(historyCalls()).toBe(1);
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type: 'disconnected' } }); });
    // Another client writes while this one is disconnected. Only a real history
    // request delivers these rows to the hook; the test never calls mergeHistory.
    serverRows = [
      { id: '1', turn_id: 'turn-a', request_id: request, role: 'user', content: 'A' },
      { id: '2', turn_id: 'turn-a', request_id: request, role: 'assistant', content: 'answer' },
      { id: '3', turn_id: 'other-client', role: 'user', content: '3' },
      { id: '4', turn_id: 'other-client', role: 'assistant', content: '4' },
    ];
    await tick(1000);
    expect(app.connected).toBe(true);
    expect(app.messages.map(row => row.content)).toEqual(['A', 'answer', '3', '4']);
    expect(historyCalls()).toBe(2);
    expect(app.messages.slice(0, 2).map(row => row.id)).toEqual(localIds);
    expect(app.thinking).toBe(false);
    // A second reconnect receives the same persisted snapshot without duplicates.
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type: 'disconnected' } }); });
    await tick(1000);
    expect(historyCalls()).toBe(3);
    expect(app.messages.map(row => row.content)).toEqual(['A', 'answer', '3', '4']);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'chat')).toHaveLength(1);
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

  it.each([
    ['token_missing', 'Сначала сохраните токен.'],
    ['credential_store_unavailable', 'Системное хранилище секретов недоступно. Запустите и разблокируйте Secret Service/keyring. Токен не сохранён в файл.'],
  ])('explains keyring configuration error %s without retrying', async (code, expected) => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'connect') throw `CONFIG_ERROR: ${code}`;
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    expect(app.error).toBe(expected);
    await tick(120000);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'connect')).toHaveLength(1);
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

describe('connection check via health', () => {
  const healthEnvelope = (apiVersion: unknown) => ({ ok: true, trace_id: 't', data: { status: 'ok', ...(apiVersion === undefined ? {} : { api_version: apiVersion }) } });
  const stubApi = (health: () => unknown) => {
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
      if (command === 'api' && args?.path === '/v1/health') return health();
      if (command === 'api' && args?.path === '/openapi.json') throw new Error('HTTP 404');
      return base(command, args);
    });
  };
  const openapiCalls = () => ipc.invoke.mock.calls.filter(([, args]) => (args as { path?: string })?.path === '/openapi.json');

  it('succeeds when health is available and OpenAPI is closed', async () => {
    stubApi(() => healthEnvelope('1.1.0'));
    await mount();
    await act(async () => { await app.check(); });
    expect(app.error).toBe('');
    expect(app.notice).toContain('Сервер доступен · API 1.1.0');
    expect(app.status).toMatchObject({ api_version: '1.1.0' });
    expect(openapiCalls()).toHaveLength(0);
  });

  it('fails the check when the health endpoint is unavailable', async () => {
    stubApi(() => { throw 'connection refused'; });
    await mount();
    await act(async () => { await app.check(); });
    expect(app.error).toContain('connection refused');
    expect(app.status).toBeUndefined();
    expect(app.notice).toBe('');
  });

  it('surfaces an auth failure from health without connecting', async () => {
    stubApi(() => { throw 'HTTP 401'; });
    await mount();
    await act(async () => { await app.check(); });
    expect(app.error).toContain('HTTP 401');
    expect(app.status).toBeUndefined();
  });

  it.each([['newer', '2.0.0'], ['missing', undefined]])('rejects an incompatible health version: %s', async (_kind, apiVersion) => {
    stubApi(() => healthEnvelope(apiVersion));
    await mount();
    await act(async () => { await app.check(); });
    expect(app.error).toBe('Несовместимая версия API. Требуется 1.x.');
    expect(app.status).toBeUndefined();
  });
});

describe('chat IPC and WSS ordering', () => {
  function deferChat() {
    const base = ipc.invoke.getMockImplementation()!;
    let resolve!: (result: { handled: boolean; command?: string }) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<{ handled: boolean; command?: string }>((yes, no) => { resolve = yes; reject = no; });
    ipc.invoke.mockImplementation((command, args) => command === 'chat' ? pending : base(command, args));
    return { resolve, reject, restore: () => ipc.invoke.mockImplementation(base) };
  }
  function requestId() {
    return ipc.invoke.mock.calls.filter(([command]) => command === 'chat').at(-1)?.[1]?.requestId ?? 'rust-generated-id';
  }
  async function emit(payload: Record<string, unknown>) {
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload }); });
  }
  async function send(value = 'hello') {
    let sending!: Promise<void>;
    await act(async () => { app.setText(value); });
    await act(async () => { sending = app.sendContent(value); });
    return { finish: () => sending };
  }

  it('keeps user before assistant when done arrives before IPC resolves', async () => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send();
    await emit({ type: 'done', source: 'bridge', request_id: requestId(), text: 'answer' });
    await act(async () => { ipcChat.resolve({ handled: false }); await sending.finish(); });
    expect(app.messages.map(message => [message.role, message.content])).toEqual([['user', 'hello'], ['assistant', 'answer']]);
    expect(app.thinking).toBe(false);
    expect(app.text).toBe('');
  });

  it('does not re-enable thinking after an early done, and accepts the next turn', async () => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send();
    await emit({ type: 'done', source: 'bridge', request_id: requestId(), text: 'answer' });
    await act(async () => { ipcChat.resolve({ handled: false }); await sending.finish(); });
    expect(app.thinking).toBe(false);
    ipcChat.restore();
    await act(async () => { await app.sendContent('next'); });
    expect(app.thinking).toBe(true);
    await emit({ type: 'done', source: 'bridge', request_id: requestId(), text: 'next answer' });
    expect(app.messages.map(message => message.content)).toEqual(['hello', 'answer', 'next', 'next answer']);
    expect(app.thinking).toBe(false);
  });

  it('rolls back only the rejected user and retries the preserved draft without duplicates', async () => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send();
    await act(async () => { ipcChat.reject('offline'); await sending.finish(); });
    expect(app.text).toBe('hello');
    expect(app.messages).toEqual([]);
    expect(app.thinking).toBe(false);
    expect(app.error).toContain('Сообщение не отправлено');
    ipcChat.restore();
    await act(async () => { await app.sendContent(app.text); });
    expect(app.messages.map(message => message.content)).toEqual(['hello']);
  });

  it.each(['stop', 'disconnect', 'cancelled', 'disconnected', 'error'])('does not resurrect an interrupted turn after %s', async interruption => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send();
    const oldId = requestId();
    if (interruption === 'stop' || interruption === 'disconnect') await act(async () => { await app[interruption](); });
    else await emit({ type: interruption, source: 'bridge', request_id: interruption === 'disconnected' ? undefined : oldId });
    await act(async () => { app.setText('new draft'); ipcChat.resolve({ handled: false }); await sending.finish(); });
    await emit({ type: 'token', source: 'bridge', request_id: oldId, text: 'late token' });
    await emit({ type: 'done', source: 'bridge', request_id: oldId, text: 'late answer' });
    await tick(100);
    expect(app.thinking).toBe(false);
    expect(app.partial).toBe('');
    expect(app.text).toBe('new draft');
    expect(app.messages.map(message => message.content)).toEqual(['hello']);
  });

  it('ignores stale and duplicate IDs without disturbing the next request', async () => {
    await mount();
    await act(async () => { await app.sendContent('first'); });
    const oldId = requestId();
    await emit({ type: 'done', source: 'bridge', request_id: oldId, text: 'first answer' });
    await act(async () => { await app.sendContent('second'); });
    const newId = requestId();
    expect(newId).not.toBe(oldId);
    for (const type of ['token', 'done', 'error', 'cancelled']) await emit({ type, source: 'bridge', request_id: oldId, text: 'stale' });
    expect(app.thinking).toBe(true);
    await emit({ type: 'done', source: 'bridge', request_id: newId, text: 'second answer' });
    await emit({ type: 'done', source: 'bridge', request_id: newId, text: 'duplicate' });
    expect(app.messages.map(message => message.content)).toEqual(['first', 'first answer', 'second', 'second answer']);
    expect(app.thinking).toBe(false);
  });

  it('settles handled local commands with early runner events and no WSS reply', async () => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send('local command');
    await act(async () => { ipc.listeners.get('command-run')!({ payload: { state: 'finished', name: 'local' } }); });
    await act(async () => { ipcChat.resolve({ handled: true, command: 'local' }); await sending.finish(); });
    expect(app.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(app.messages[1].content).toContain('«local»');
    expect(app.thinking).toBe(false);
    expect(app.busy).toBe(false);
  });

  it.each(['success', 'failure'])('does not overwrite an edited draft on IPC %s', async outcome => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send();
    await act(async () => { app.setText('edited'); if (outcome === 'success') ipcChat.resolve({ handled: false }); else ipcChat.reject('offline'); await sending.finish(); });
    expect(app.text).toBe('edited');
  });

  it('retains a confirmed WSS answer even if IPC later rejects, then permits another turn', async () => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send();
    await emit({ type: 'done', source: 'bridge', request_id: requestId(), text: 'answer' });
    await act(async () => { ipcChat.reject('late IPC failure'); await sending.finish(); });
    expect(app.messages.map(message => message.content)).toEqual(['hello', 'answer']);
    expect(app.thinking).toBe(false);
    expect(app.error).toBe('');
    ipcChat.restore();
    await act(async () => { await app.sendContent('next'); });
    expect(app.messages.at(-1)?.content).toBe('next');
  });

  it('does not turn a cancelled pending local command into a new assistant reply', async () => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send('local command');
    await act(async () => { await app.stop(); });
    await act(async () => { ipcChat.resolve({ handled: true, command: 'local' }); await sending.finish(); });
    expect(app.messages.map(message => message.role)).toEqual(['user']);
    expect(app.thinking).toBe(false);
  });

  it('leaves voice request IDs and live-run filtering to the voice lifecycle', async () => {
    await mount();
    await emit({ type: 'live.started', run: 2 });
    await emit({ type: 'done', source: 'voice', request_id: 'voice-turn', run: 1, text: 'stale voice' });
    expect(app.messages).toEqual([]);
    await emit({ type: 'done', source: 'voice', request_id: 'voice-turn', run: 2, text: 'voice answer' });
    expect(app.messages.map(message => message.content)).toEqual(['voice answer']);
    expect(app.thinking).toBe(true);
  });

  it('does not lose existing history when an optimistic row at the limit is rejected', async () => {
    await mount();
    await emit({ type: 'history', messages: Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `history ${i}` })) });
    const previous = app.messages;
    const ipcChat = deferChat();
    const sending = await send();
    await act(async () => { ipcChat.reject('offline'); await sending.finish(); });
    expect(app.messages).toEqual(previous);
    expect(app.text).toBe('hello');
  });

  it('does not submit the same pending turn twice', async () => {
    await mount();
    const ipcChat = deferChat();
    const sending = await send();
    await act(async () => { await app.sendContent('hello'); });
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'chat')).toHaveLength(1);
    await act(async () => { ipcChat.resolve({ handled: false }); await sending.finish(); });
  });
});

describe('text turn isolation and late history', () => {
  const requestId = () => ipc.invoke.mock.calls.filter(([command]) => command === 'chat').at(-1)?.[1]?.requestId;
  async function emit(payload: Record<string, unknown>) {
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload }); });
  }
  function deferredChat() {
    const base = ipc.invoke.getMockImplementation()!;
    let resolve!: (result: { handled: boolean; command?: string }) => void;
    const promise = new Promise<{ handled: boolean; command?: string }>(done => { resolve = done; });
    ipc.invoke.mockImplementation((name, args) => name === 'chat' ? promise : base(name, args));
    return resolve;
  }

  it.each([
    { type: 'error', code: 'audio_unavailable' },
    { type: 'error', source: 'voice', code: 'voice_failed' },
    { type: 'cancelled', source: 'voice' },
    { type: 'cancelled' },
  ])('retains active text A through unrelated $type/$source', async unrelated => {
    await mount();
    await act(async () => { await app.sendContent('A'); });
    const id = requestId();
    await emit({ type: 'token', source: 'bridge', request_id: id, text: 'part A' });
    await tick(100);
    await emit(unrelated);
    expect(app.thinking).toBe(true);
    expect(app.partial).toBe('part A');
    await emit({ type: 'done', source: 'bridge', request_id: id, text: 'answer A' });
    expect(app.messages.map(message => message.content)).toEqual(['A', 'answer A']);
    expect(app.thinking).toBe(false);
  });

  it.each(['done-before-ack', 'done-after-ack', 'handled'])('preserves optimistic A after late history for %s', async order => {
    await mount();
    const resolve = deferredChat();
    let sending!: Promise<void>;
    await act(async () => { sending = app.sendContent('A'); });
    const id = requestId();
    await emit({ type: 'history', source: 'bridge', messages: [] });
    if (order === 'done-before-ack') await emit({ type: 'done', source: 'bridge', request_id: id, text: 'answer A' });
    await act(async () => { resolve({ handled: order === 'handled', command: 'local' }); await sending; });
    if (order === 'done-after-ack') await emit({ type: 'done', source: 'bridge', request_id: id, text: 'answer A' });
    expect(app.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(app.messages[0].content).toBe('A');
    expect(app.thinking).toBe(false);
    await emit({ type: 'history', source: 'bridge', messages: [{ role: 'user', content: 'A' }] });
    expect(app.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });
  it.each(['before-ack', 'after-ack'])('merges older history after terminal A, %s, preserving repeated rows', async order => {
    await mount();
    const resolve = deferredChat();
    let sending!: Promise<void>;
    await act(async () => { sending = app.sendContent('A'); });
    await emit({ type: 'done', source: 'bridge', request_id: requestId(), text: 'answer A' });
    if (order === 'after-ack') await act(async () => { resolve({ handled: false }); await sending; });
    const id = requestId();
    const older = [
      { id: 1, role: 'user', content: 'repeat' }, { id: 2, role: 'assistant', content: 'same' },
      { id: 3, role: 'user', content: 'repeat' }, { id: 4, role: 'assistant', content: 'same' },
    ];
    await emit({ type: 'history', messages: older });
    expect(app.messages.map(row => row.content)).toEqual(['repeat', 'same', 'repeat', 'same', 'A', 'answer A']);
    const userId = app.messages[4].id;
    // Repeated delivery and snapshots overlapping the optimistic turn must be idempotent.
    for (const messages of [older, [...older, { id: 5, request_id: id, role: 'user', content: 'A' }], [...older, { id: 5, request_id: id, role: 'user', content: 'A' }, { id: 6, request_id: id, role: 'assistant', content: 'answer A' }]]) {
      await emit({ type: 'history', messages });
      expect(app.messages.map(row => row.content)).toEqual(['repeat', 'same', 'repeat', 'same', 'A', 'answer A']);
      expect(app.messages[4].id).toBe(userId);
    }
    if (order === 'before-ack') await act(async () => { resolve({ handled: false }); await sending; });
    expect(app.thinking).toBe(false);
  });

  it('distinguishes identical old and optimistic turns by persisted identity across reconnect', async () => {
    await mount();
    const oldRequest = crypto.randomUUID();
    const oldRows = [
      { id: 101, turn_id: 'old-turn', request_id: oldRequest, role: 'user', content: 'A' },
      { id: 102, turn_id: 'old-turn', request_id: oldRequest, role: 'assistant', content: 'same answer' },
    ];
    const resolve = deferredChat();
    let sending!: Promise<void>;
    await act(async () => { sending = app.sendContent('A'); });
    const currentRequest = requestId();
    await emit({ type: 'done', source: 'bridge', request_id: currentRequest, text: 'same answer' });
    await emit({ type: 'history', messages: oldRows });
    expect(app.messages.map(row => row.content)).toEqual(['A', 'same answer', 'A', 'same answer']);
    const localIds = app.messages.slice(2).map(row => row.id);
    const allRows = [...oldRows,
      { id: 103, turn_id: 'new-turn', request_id: currentRequest, role: 'user', content: 'A' },
      { id: 104, turn_id: 'new-turn', request_id: currentRequest, role: 'assistant', content: 'same answer' },
    ];
    for (const messages of [allRows, oldRows, allRows]) {
      await emit({ type: 'history', messages });
      expect(app.messages.map(row => row.content)).toEqual(['A', 'same answer', 'A', 'same answer']);
      expect(app.messages.slice(2).map(row => row.id)).toEqual(localIds);
    }
    await act(async () => { resolve({ handled: false }); await sending; });
    await emit({ type: 'disconnected' });
    await emit({ type: 'history', messages: allRows });
    expect(app.messages.map(row => row.content)).toEqual(['A', 'same answer', 'A', 'same answer']);
  });

  it('correlates persisted user before terminal and rejected IPC without losing older identical text', async () => {
    await mount();
    const base = ipc.invoke.getMockImplementation()!;
    let reject!: (reason: Error) => void;
    ipc.invoke.mockImplementation((name, args) => name === 'chat' ? new Promise((_, fail) => { reject = fail; }) : base(name, args));
    let sending!: Promise<void>;
    await act(async () => { sending = app.sendContent('A'); });
    await emit({ type: 'history', messages: [
      { id: 1, turn_id: 'old', role: 'user', content: 'A' },
      { id: 2, turn_id: 'current', request_id: requestId(), role: 'user', content: 'A' },
    ] });
    expect(app.messages).toHaveLength(2);
    await act(async () => { reject(new Error('lost ack')); await sending; });
    expect(app.messages.map(row => row.content)).toEqual(['A']);
    expect(app.text).toBe('A');
  });

  it('does not duplicate an assistant persisted before its terminal event', async () => {
    await mount();
    await act(async () => { await app.sendContent('A'); });
    const id = requestId();
    const rows = [
      { id: '1', turn_id: 'turn', request_id: id, role: 'user', content: 'A' },
      { id: '2', turn_id: 'turn', request_id: id, role: 'assistant', content: 'answer A' },
    ];
    await emit({ type: 'history', messages: rows });
    await emit({ type: 'done', source: 'bridge', request_id: id, text: 'answer A' });
    expect(app.messages.map(row => row.content)).toEqual(['A', 'answer A']);
    const saved = ipc.invoke.mock.calls.filter(([name]) => name === 'save_chats').at(-1)![1].threads;
    expect(saved[0].messages[0]).toMatchObject({ serverId: '1', turnId: 'turn', requestId: id });
    await act(async () => { root.unmount(); });
    const base = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation((name, args) => name === 'load_chats' ? Promise.resolve(saved) : base(name, args));
    await mount();
    await act(async () => { await app.sendContent('B'); });
    await emit({ type: 'history', messages: rows });
    expect(app.messages.map(row => row.content)).toEqual(['A', 'answer A', 'B']);
  });

  it('honours a native global Stop while preserving other channel isolation', async () => {
    await mount();
    await act(async () => { await app.sendContent('A'); });
    const id = requestId();
    await emit({ type: 'cancelled', scope: 'all' });
    await emit({ type: 'done', source: 'bridge', request_id: id, text: 'late A' });
    expect(app.messages.map(message => message.content)).toEqual(['A']);
    expect(app.thinking).toBe(false);
  });

  it('does not dispatch if Stop occurs before the native ticket reply', async () => {
    await mount();
    const base = ipc.invoke.getMockImplementation()!;
    let ticket!: (epoch: number) => void;
    const epoch = new Promise<number>(resolve => { ticket = resolve; });
    ipc.invoke.mockImplementation((name, args) => name === 'chat_epoch' ? epoch : base(name, args));
    let sending!: Promise<void>;
    await act(async () => { sending = app.sendContent('A'); });
    await act(async () => { await app.stop(); });
    await act(async () => { ticket(7); await sending; });
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'chat')).toHaveLength(0);
    expect(app.thinking).toBe(false);
    await act(async () => { await app.sendContent('B'); });
    expect(ipc.invoke).toHaveBeenCalledWith('chat', expect.objectContaining({ text: 'B', dispatchEpoch: 7 }));
  });

});
