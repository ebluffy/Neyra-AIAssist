import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { GearMenu } from './components/GearMenu';
import { ServerPanel } from './components/ServerPanel';
import { Composer } from './components/Composer';
import { VoicePanel } from './components/VoicePanel';
import { defaultVoice, type AudioDevices, type Settings } from './types';
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

let recordSeq = 0;

beforeEach(() => {
  recordSeq = 0;
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
    if (command === 'record_start') return (recordSeq += 1);
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

  it.each(['during-open', 'after-open'])('reconciles cached thread with server rows when history arrives %s', async delivery => {
    const targetSession = '22222222-2222-4222-8222-222222222222';
    const cached = [
      { id: 'local-a', serverId: '1', turnId: 'turn-a', role: 'user', content: 'A', kind: 'text' },
      { id: 'local-answer', serverId: '2', turnId: 'turn-a', role: 'assistant', content: 'answer', kind: 'text' },
    ];
    const stored = [
      { id: 'current', title: 'Current', sessionId: settings.profiles[0].session_id, updated: 2,
        messages: [{ id: 'other', role: 'user', content: 'other thread', kind: 'text' }] },
      { id: 'cached', title: 'A', sessionId: targetSession, updated: 1, messages: cached },
    ];
    const rows = [
      { id: '1', turn_id: 'turn-a', role: 'user', content: 'A' },
      { id: '2', turn_id: 'turn-a', role: 'assistant', content: 'answer' },
      { id: '3', turn_id: 'remote', role: 'user', content: '3' },
      { id: '4', turn_id: 'remote', role: 'assistant', content: '4' },
    ];
    const base = ipc.invoke.getMockImplementation()!;
    let session = settings.profiles[0].session_id;
    let deliver = () => {};
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'load_chats') return stored;
      if (command === 'save_settings') session = args.settings.profiles[0].session_id;
      if (command === 'bridge_message' && args?.kind === 'history') {
        const send = () => ipc.listeners.get('desktop-event')!({ payload: { type: 'history', messages: session === targetSession ? rows : [] } });
        if (session === targetSession && delivery === 'after-open') deliver = send;
        else send();
      }
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    await act(async () => { await app.openThread('cached'); });
    if (delivery === 'after-open') await act(async () => { deliver(); });
    expect(app.messages.map(row => row.content)).toEqual(['A', 'answer', '3', '4']);
    expect(app.messages.slice(0, 2).map(row => row.id)).toEqual(['local-a', 'local-answer']);
    expect(app.threads.find(thread => thread.id === 'current')!.messages.map(row => row.content)).toEqual(['other thread']);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'chat')).toHaveLength(0);
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type: 'history', messages: rows } }); });
    expect(app.messages.map(row => row.content)).toEqual(['A', 'answer', '3', '4']);
  });

  it('restores the previous thread when opening a cached session fails', async () => {
    const base = ipc.invoke.getMockImplementation()!;
    let failConnect = false;
    ipc.invoke.mockImplementation(async (command, args) => {
      if (command === 'load_chats') return [
        { id: 'current', title: 'Current', sessionId: settings.profiles[0].session_id, updated: 2,
          messages: [{ id: 'original', role: 'user', content: 'original thread', kind: 'text' }] },
        { id: 'cached', title: 'Cached', sessionId: '22222222-2222-4222-8222-222222222222', updated: 1,
          messages: [{ id: 'cached-a', role: 'user', content: 'A', kind: 'text' }] },
      ];
      if (command === 'connect' && failConnect) throw new Error('target unavailable');
      return base(command, args);
    });
    await mount();
    await act(async () => { await app.connect(); });
    await tick(0);
    failConnect = true;
    await act(async () => { await app.openThread('cached'); });
    expect(app.activeId).toBe('current');
    expect(app.messages.map(row => row.content)).toEqual(['original thread']);
    expect(app.threads.find(thread => thread.id === 'cached')!.messages.map(row => row.content)).toEqual(['A']);
    expect(app.error).toBe('Действие не выполнено. Повторите попытку.');
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

  it.each([
    ['handshake', 'Токен отклонён сервером'],
    ['revoked', 'Сеанс отключён с сервера'],
  ])('stops automatic retries after auth rejection: %s', async (mode, expected) => {
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
    expect(app.error).toContain(expected);
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

  it('separates local audio output errors from server errors in desktop-event handler', async () => {
    await mount();
    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 'audio_unavailable' } });
    });
    expect(app.error).toBe('Ошибка звука: audio_unavailable. Проверьте аудиоустройство.');
    expect(app.thinking).toBe(false);

    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 'microphone_unavailable' } });
    });
    expect(app.error).toBe('Ошибка звука: microphone_unavailable. Проверьте микрофон и его разрешение в системе.');

    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 'audio_backpressure' } });
    });
    expect(app.error).toBe('Ошибка звука: audio_backpressure. Очередь озвучки переполнена, ответ показан текстом.');

    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 'wake_failed' } });
    });
    expect(app.error).toBe('Ошибка звука: wake_failed. Прослушивание по слову не запустилось, проверьте микрофон.');

    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 'audio_invalid' } });
    });
    expect(app.error).toBe('Ошибка звука: audio_invalid. Не удалось воспроизвести ответ, текст показан в чате.');

    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 'voice_failed' } });
    });
    expect(app.error).toBe('Сервер: voice_failed. Повторите попытку.');

    // A server error that only looks like a local audio code must stay a server error.
    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 'audio_pipeline_broken' } });
    });
    expect(app.error).toBe('Сервер: audio_pipeline_broken. Повторите попытку.');

    await act(async () => {
      ipc.listeners.get('desktop-event')!({ payload: { type: 'error', code: 42 } });
    });
    expect(app.error).toBe('Сервер: ошибка. Повторите попытку.');
  });

  it('clears recording state when record_stop rejects with empty recording or error, allowing restart', async () => {
    await mount();
    ipc.invoke.mockImplementation(async (command: string) => {
      if (command === 'record_start') return {};
      if (command === 'record_stop') throw 'Запись пустая';
      return {};
    });

    await act(async () => { await app.beginRecording(); });
    expect(app.recording).toBe(true);

    await act(async () => { await app.finishRecording(); });
    expect(app.recording).toBe(false);
    expect(app.error).toContain('Запись пустая');
    expect(app.thinking).toBe(false);

    // Can immediately start recording again without being locked
    await act(async () => { await app.beginRecording(); });
    expect(app.recording).toBe(true);
  });
});

describe('PTT deferred IPC lifecycle', () => {
  function defer(commandName = 'record_stop') {
    const base = ipc.invoke.getMockImplementation()!;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    ipc.invoke.mockImplementation((command, args) => command === commandName ? promise : base(command, args));
    return { resolve, reject };
  }
  async function event(type: string, extra = {}) {
    await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type, ...extra } }); });
  }
  async function startStop(path: string) {
    await act(async () => { await app.beginRecording(); });
    let pending: Promise<void> = Promise.resolve();
    if (path === 'manual') await act(async () => { pending = app.finishRecording(); });
    else await tick(30000);
    return { settle: async () => { await act(async () => { await pending; }); } };
  }

  describe.each(['manual', 'limit'])('%s record_stop', path => {
    it.each(['error', 'cancelled', 'disconnected', 'speaking', 'done'])('does not overwrite early %s with successful IPC acknowledgement', async type => {
      await mount();
      const ipcStop = defer();
      const pending = await startStop(path);
      await event(type, { code: 'voice_failed', text: 'answer' });
      const notice = app.notice;
      const error = app.error;
      await act(async () => { ipcStop.resolve(); });
      await pending.settle();
      expect(app.thinking).toBe(false);
      expect(app.recording).toBe(false);
      expect(app.notice).toBe(notice);
      expect(app.error).toBe(error);
    });

    it('keeps a successful acknowledgement waiting for transcription', async () => {
      await mount();
      const ipcStop = defer();
      const pending = await startStop(path);
      await act(async () => { ipcStop.resolve(); });
      await pending.settle();
      expect(app.thinking).toBe(true);
      expect(app.recording).toBe(false);
    });

    it.each(['resolve', 'reject'])('does not change a new capture after Stop and late IPC %s', async outcome => {
      await mount();
      const ipcStop = defer();
      const pending = await startStop(path);
      await act(async () => { await app.stop(); await app.beginRecording(); });
      const notice = app.notice;
      await act(async () => { if (outcome === 'resolve') ipcStop.resolve(); else ipcStop.reject('old failure'); });
      await pending.settle();
      expect(app.recording).toBe(true);
      expect(app.thinking).toBe(false);
      expect(app.error).toBe('');
      expect(app.notice).toBe(notice);
    });

    it('does not overwrite a terminal server error with a late IPC rejection', async () => {
      await mount();
      const ipcStop = defer();
      const pending = await startStop(path);
      await event('voice.clip', { request_id: 'turn-1', seq: 1 });
      await event('error', { code: 'voice_failed', request_id: 'turn-1' });
      await act(async () => { ipcStop.reject('old failure'); });
      await pending.settle();
      expect(app.error).toBe('Сервер: voice_failed. Повторите попытку.');
      expect(app.thinking).toBe(false);
    });

    it('clears failed processing and allows another capture on IPC rejection', async () => {
      await mount();
      const ipcStop = defer();
      const pending = await startStop(path);
      await act(async () => { ipcStop.reject('Запись пустая'); });
      await pending.settle();
      expect(app.recording).toBe(false);
      expect(app.thinking).toBe(false);
      expect(app.error).toBe('Запись пустая');
      await act(async () => { await app.beginRecording(); });
      expect(app.recording).toBe(true);
    });
  });

  it.each(['manual', 'limit'])('%s preserves the voice done TTS notice until speaking', async path => {
    await mount();
    const ipcStop = defer();
    const pending = await startStop(path);
    await event('done', { source: 'voice', text: 'answer' });
    await act(async () => { ipcStop.resolve(); });
    await pending.settle();
    expect(app.thinking).toBe(true);
    expect(app.notice).toBe('Готовлю озвучку…');
    await event('speaking');
    expect(app.thinking).toBe(false);
  });

  it.each(['resolve', 'reject'])('does not reset a new capture after a late record_cancel %s', async outcome => {
    await mount();
    const ipcCancel = defer('record_cancel');
    await act(async () => { await app.beginRecording(); });
    let pending!: Promise<void>;
    await act(async () => { pending = app.cancelRecording(); });
    await act(async () => { await app.stop(); await app.beginRecording(); });
    await act(async () => { if (outcome === 'resolve') ipcCancel.resolve(); else ipcCancel.reject('old cancel'); await pending; });
    expect(app.recording).toBe(true);
    expect(app.error).toBe('');
  });

  it('clears recording in finally when record_cancel rejects', async () => {
    await mount();
    const ipcCancel = defer('record_cancel');
    await act(async () => { await app.beginRecording(); });
    let pending!: Promise<void>;
    await act(async () => { pending = app.cancelRecording(); });
    await act(async () => { ipcCancel.reject('cancel failed'); await pending; });
    expect(app.recording).toBe(false);
    expect(app.thinking).toBe(false);
    expect(app.error).toBe('cancel failed');
    await act(async () => { await app.beginRecording(); });
    expect(app.recording).toBe(true);
  });

  it('does not revive a record_start acknowledgement after Stop', async () => {
    await mount();
    const ipcStart = defer('record_start');
    let pending!: Promise<void>;
    await act(async () => { pending = app.beginRecording(); });
    await act(async () => { await app.stop(); });
    await act(async () => { ipcStart.resolve(); await pending; });
    expect(app.recording).toBe(false);
  });

  it('commits a short press released while record_start is opening', async () => {
    await mount();
    const ipcStart = defer('record_start');
    let pending!: Promise<void>;
    await act(async () => { pending = app.beginRecording(); });
    await act(async () => { await app.finishRecording(); });
    expect(app.recording).toBe(false);
    expect(app.thinking).toBe(true);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(0);

    await act(async () => { ipcStart.resolve(); await pending; });
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_cancel')).toHaveLength(0);
    expect(app.recording).toBe(false);
    expect(app.thinking).toBe(true);
    expect(app.error).toBe('');
  });

  it.each(['stop', 'cancelled', 'disconnected'])('cancels a capture that opens after %s', async kind => {
    await mount();
    const ipcStart = defer('record_start');
    let pending!: Promise<void>;
    await act(async () => { pending = app.beginRecording(); });
    if (kind === 'stop') await act(async () => { await app.stop(); });
    else await act(async () => { ipc.listeners.get('desktop-event')!({ payload: { type: kind } }); });

    await act(async () => { ipcStart.resolve(); await pending; });
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_cancel')).toHaveLength(1);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(0);
    expect(app.recording).toBe(false);
  });

  it('does not send a second record_stop when the limit expires during manual IPC', async () => {
    await mount();
    const ipcStop = defer();
    const pending = await startStop('manual');
    await tick(30000);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
    await act(async () => { ipcStop.resolve(); });
    await pending.settle();
  });

  it.each(['audio_backpressure', 'wake_failed', 'chat_failed', 'voice_unavailable'])(
    'a foreign %s error while the mic is open still stops the capture on release (AR-11)',
    async code => {
      await mount();
      await act(async () => { await app.beginRecording(); });
      expect(app.recording).toBe(true);

      // A player/wake error of another feature is not this capture's stop.
      await event('error', { code });
      expect(app.recording).toBe(true);
      expect(app.thinking).toBe(false);

      await act(async () => { await app.finishRecording(); });
      expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
      expect(app.recording).toBe(false);
    },
  );

  it('a foreign error does not freeze the 30s limit (AR-11)', async () => {
    await mount();
    await act(async () => { await app.beginRecording(); });
    await event('error', { code: 'audio_backpressure' });
    await tick(30000);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
    expect(app.recording).toBe(false);
  });

  it('commits a short press released while an unrelated speaking event arrives (AR-12)', async () => {
    await mount();
    const ipcStart = defer('record_start');
    let pending!: Promise<void>;
    await act(async () => { pending = app.beginRecording(); });
    await event('speaking');
    await act(async () => { await app.finishRecording(); });
    await act(async () => { ipcStart.resolve(); await pending; });

    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_cancel')).toHaveLength(0);
    expect(app.error).toBe('');
  });

  it('keeps a held capture running when an unrelated error arrives while opening (AR-12)', async () => {
    await mount();
    const ipcStart = defer('record_start');
    let pending!: Promise<void>;
    await act(async () => { pending = app.beginRecording(); });
    await event('error', { code: 'audio_backpressure' });
    await act(async () => { ipcStart.resolve(); await pending; });

    expect(app.recording).toBe(true);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_cancel')).toHaveLength(0);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(0);
  });

  it.each(['speaking', 'done'])(
    'does not lose record_stop error when unrelated %s event arrives while IPC is in flight (AR-14)',
    async foreignType => {
      await mount();
      const ipcStop = defer('record_stop');
      await act(async () => { await app.beginRecording(); });
      let pending!: Promise<void>;
      await act(async () => { pending = app.finishRecording(); });
      expect(app.thinking).toBe(true);
      await event(foreignType, { text: 'foreign reply' });
      await act(async () => {
        ipcStop.reject('Микрофон недоступен');
        await pending;
      });
      expect(app.error).toBe('Микрофон недоступен');
      expect(app.thinking).toBe(false);
      expect(app.recording).toBe(false);
    },
  );

  it.each(['manual', 'limit'])('keeps UI capture stoppable after a rejected foreign hotkey start: %s', async path => {
    await mount();
    await act(async () => { await app.beginRecording(); });
    await event('capture.failed', { stage: 'start', code: 'already_recording' });
    expect(app.recording).toBe(true);
    if (path === 'manual') await act(async () => { await app.finishRecording(); });
    else await tick(30000);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
  });

  it.each(['manual', 'opening'])('shows capture rejection instead of an unrelated player error: %s', async path => {
    await mount();
    const start = path === 'opening' ? defer('record_start') : null;
    const stop = defer('record_stop');
    let starting!: Promise<void>;
    await act(async () => { starting = app.beginRecording(); if (!start) await starting; });
    let finishing!: Promise<void>;
    await act(async () => { finishing = app.finishRecording(); });
    if (start) await act(async () => { start.resolve(); });
    await event('error', { source: 'player', code: 'audio_unavailable' });
    await act(async () => { stop.reject('Запись пустая'); await starting; await finishing; });
    expect(app.error).toBe('Запись пустая');
    expect(app.thinking).toBe(false);
  });

  it.each(['tts_unavailable', 'voice_failed', 'conversion_failed'])(
    'a %s playback error during the commit window never replaces the real rejection (P3-1)',
    async code => {
      await mount();
      const stop = defer('record_stop');
      await act(async () => { await app.beginRecording(); });
      let finishing!: Promise<void>;
      await act(async () => { finishing = app.finishRecording(); });
      // Errors without a clip must not replace the rejection even if they carry a request_id.
      await event('error', { source: 'voice', code, request_id: `no-clip-${code}` });
      await act(async () => { stop.reject('Запись пустая, повторите.'); await finishing; });
      expect(app.error).toContain('Запись пустая');
      expect(app.thinking).toBe(false);
    },
  );

  it('does not replace record_stop rejection when clip belongs to turn A and error belongs to turn B', async () => {
    await mount();
    await event('voice.clip', { request_id: 'turn-A', seq: 1 });
    const stop = defer('record_stop');
    await act(async () => { await app.beginRecording(); });
    let finishing!: Promise<void>;
    await act(async () => { finishing = app.finishRecording(); });
    await event('error', { code: 'turn_busy', request_id: 'turn-B' });
    await act(async () => { stop.reject('turn_busy'); await finishing; });
    expect(app.error).toBe('turn_busy');
    expect(app.thinking).toBe(false);
  });

  it('does not reuse a clip from the previous capture for the next one', async () => {
    await mount();
    // Capture A produced a clip; capture B starts, so A's id must stop counting.
    await event('voice.clip', { request_id: 'turn-A', seq: 1 });
    const stop = defer('record_stop');
    await act(async () => { await app.beginRecording(); });
    let finishing!: Promise<void>;
    await act(async () => { finishing = app.finishRecording(); });
    await event('error', { code: 'turn_busy', request_id: 'turn-A' });
    await act(async () => { stop.reject('turn_busy'); await finishing; });
    expect(app.error).toBe('turn_busy');
    expect(app.thinking).toBe(false);
  });

  it('ignores a clip of the previous capture that arrives after the next one started', async () => {
    await mount();
    const stop = defer('record_stop');
    // Capture B starts; the clip of the previous turn A arrives late, while B records.
    await act(async () => { await app.beginRecording(); });
    await event('voice.clip', { request_id: 'turn-A', seq: 1 });
    let finishing!: Promise<void>;
    await act(async () => { finishing = app.finishRecording(); });
    await event('error', { code: 'turn_busy', request_id: 'turn-A' });
    await act(async () => { stop.reject('turn_busy'); await finishing; });
    expect(app.error).toBe('turn_busy');
  });

  it('rejects a clip of another capture that arrives during this commit', async () => {
    await mount();
    const stop = defer('record_stop');
    await act(async () => { await app.beginRecording(); });
    let finishing!: Promise<void>;
    await act(async () => { finishing = app.finishRecording(); });
    // Capture A (seq 2) hands its clip over while capture 1 is still committing.
    await event('voice.clip', { request_id: 'turn-A', seq: 2 });
    await event('error', { code: 'turn_busy', request_id: 'turn-A' });
    await act(async () => { stop.reject('turn_busy'); await finishing; });
    expect(app.error).toBe('turn_busy');
  });

  it('ignores a late stop announcement of a capture that was replaced', async () => {
    await mount();
    await act(async () => { await app.beginRecording(); });          // capture 1
    await event('cancelled', { scope: 'all' });                        // Stop while it runs
    await act(async () => { await app.beginRecording(); });          // capture 2
    // The stop of capture 1 finishes late and reports for the old capture.
    await event('transcribing', { seq: 1 });
    expect(app.recording).toBe(true);
    await event('capture.failed', { stage: 'stop', code: 'empty_capture', seq: 1 });
    expect(app.recording).toBe(true);
    expect(app.thinking).toBe(false);
  });

  it('does not cancel a capture that is still opening when an old stop arrives', async () => {
    await mount();
    const start = defer('record_start');
    let opening!: Promise<void>;
    await act(async () => { opening = app.beginRecording(); });
    // The stop of the previous capture (seq 1) lands while this one is still opening.
    await event('capture.failed', { stage: 'stop', code: 'empty_capture', seq: 1 });
    await act(async () => { start.resolve(); await opening; });
    expect(app.recording).toBe(true);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_cancel')).toHaveLength(0);
  });

  it('does not revive processing when a stop outcome arrives after Stop', async () => {
    await mount();
    await act(async () => { await app.beginRecording(); });
    await event('cancelled', { scope: 'all' });
    await event('transcribing', { seq: 1 });
    expect(app.thinking).toBe(false);
    expect(app.recording).toBe(false);
  });

  it('accepts the transcribing of a new short tap after a Stop', async () => {
    await mount();
    await act(async () => { await app.beginRecording(); });          // capture 1
    await event('cancelled', { scope: 'all' });
    // A short hotkey tap never announces recording, so its outcome carries a new number only.
    await event('transcribing', { seq: 2 });
    expect(app.thinking).toBe(true);
    expect(app.recording).toBe(false);
  });

  it('drops a late outcome of a capture cancelled before the window saw it start', async () => {
    await mount();
    await event('cancelled', { scope: 'all', seq: 1 });   // short tap stopped while opening
    await event('transcribing', { seq: 1 });
    expect(app.thinking).toBe(false);
  });

  it('still accepts the next short tap after such a cancel', async () => {
    await mount();
    await event('cancelled', { scope: 'all', seq: 1 });
    await event('transcribing', { seq: 2 });
    expect(app.thinking).toBe(true);
  });

  it.each(['empty_capture', 'turn_busy', 'microphone_unavailable', 'no_capture', 'voice_unavailable'])(
    'hotkey record_stop error %s clears recording and prevents 30s timer stop (AR-15)',
    async errorCode => {
      await mount();
      await event('recording');
      expect(app.recording).toBe(true);

      // Hotkey release fails after taking the microphone; this is a capture-specific terminal.
      await event('capture.failed', { code: errorCode, stage: 'stop' });
      expect(app.recording).toBe(false);
      expect(app.error).toContain(errorCode);
      expect(app.thinking).toBe(false);

      // Fast-forward past 30 seconds
      await tick(30000);
      expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(0);
    },
  );

  it('shows a rejected stop after a short press released while start is opening (AR-13)', async () => {
    await mount();
    const ipcStart = defer('record_start');
    const ipcStop = defer('record_stop');
    let pending!: Promise<void>;
    await act(async () => { pending = app.beginRecording(); });
    await act(async () => { await app.finishRecording(); });
    expect(app.thinking).toBe(true);
    await act(async () => { ipcStart.resolve(); });
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
    await act(async () => { ipcStop.reject('Запись пустая, повторите.'); await pending; });
    expect(app.error).toContain('Запись пустая');
    expect(app.thinking).toBe(false);
    expect(app.recording).toBe(false);
    expect(app.notice).not.toBe('Распознаю речь…');
  });

  it('reports a failed hotkey start and permits the next capture', async () => {
    await mount();
    await event('capture.failed', { stage: 'start', code: 'microphone_unavailable' });
    expect(app.recording).toBe(false);
    expect(app.error).toContain('Проверьте микрофон');
    await act(async () => { await app.beginRecording(); });
    expect(app.recording).toBe(true);
    await act(async () => { await app.finishRecording(); });
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
  });

  it('invokes record_cancel, clears state and reports error when cancelled during pending record_start (AR-17)', async () => {
    await mount();
    const ipcStart = defer('record_start');
    const ipcCancel = defer('record_cancel');
    let startPending!: Promise<void>;
    await act(async () => { startPending = app.beginRecording(); });

    // Cancel is requested while record_start is still opening
    let cancelPending!: Promise<void>;
    await act(async () => { cancelPending = app.cancelRecording(); });
    expect(app.recording).toBe(false);
    expect(app.thinking).toBe(false);

    // Device resolves opening; hook must now trigger record_cancel
    await act(async () => { ipcStart.resolve(); });
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_cancel')).toHaveLength(1);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(0);

    // record_cancel fails with an error
    await act(async () => {
      ipcCancel.reject('Ошибка отмены записи');
      await startPending;
      await cancelPending;
    });

    expect(app.error).toBe('Ошибка отмены записи');
    expect(app.recording).toBe(false);
    expect(app.thinking).toBe(false);

    // Allows subsequent capture
    await act(async () => { await app.beginRecording(); });
    expect(app.recording).toBe(true);
  });

  it('invokes record_cancel and resets state on successful cancel during pending record_start (AR-17)', async () => {
    await mount();
    const ipcStart = defer('record_start');
    const ipcCancel = defer('record_cancel');
    let startPending!: Promise<void>;
    await act(async () => { startPending = app.beginRecording(); });

    await act(async () => { void app.cancelRecording(); });
    expect(app.recording).toBe(false);

    await act(async () => { ipcStart.resolve(); });
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_cancel')).toHaveLength(1);

    await act(async () => {
      ipcCancel.resolve();
      await startPending;
    });

    expect(app.notice).toBe('Запись отменена');
    expect(app.recording).toBe(false);
    expect(app.thinking).toBe(false);
    expect(app.error).toBe('');
  });

  it('handles record_start mutual exclusion rejection without corrupting capture state', async () => {
    await mount();
    ipc.invoke.mockImplementation(async (command: string) => {
      if (command === 'record_start') throw 'Запись уже идёт';
      return {};
    });

    await act(async () => {
      await app.beginRecording();
    });

    expect(app.error).toBe('Запись уже идёт');
    expect(app.recording).toBe(false);
    expect(app.thinking).toBe(false);
  });
});

describe('voice audio devices (AR-1)', () => {
  const sampleDevices: AudioDevices = {
    input_devices: ['Встроенный микрофон', 'USB Наушники Mic'],
    output_devices: ['Встроенные динамики', 'USB Наушники Audio'],
    default_input: 'Встроенный микрофон',
    default_output: 'Встроенные динамики',
  };

  it('loads audio devices when voice sheet is opened', async () => {
    ipc.invoke.mockImplementation(async (command: string, args?: { settings?: unknown }) => {
      if (command === 'load_settings') return { settings, data_root: '', global_shortcuts: false, pc_access_available: false };
      if (command === 'save_settings') return args?.settings;
      if (command === 'audio_devices') return sampleDevices;
      if (command === 'voice_status') return { wake: { ready: true, dir: '/wakeword' }, live: false, dropped_frames: 0 };
      return {};
    });
    await mount();

    await act(async () => {
      app.openSheet('voice');
    });

    expect(ipc.invoke).toHaveBeenCalledWith('audio_devices');
    expect(app.audioDevices).toEqual(sampleDevices);
  });

  it('refreshes audio devices and status via refreshVoice', async () => {
    ipc.invoke.mockImplementation(async (command: string, args?: { settings?: unknown }) => {
      if (command === 'load_settings') return { settings, data_root: '', global_shortcuts: false, pc_access_available: false };
      if (command === 'save_settings') return args?.settings;
      if (command === 'audio_devices') return sampleDevices;
      if (command === 'voice_status') return { wake: { ready: true, dir: '/wakeword' }, live: false, dropped_frames: 0 };
      return {};
    });
    await mount();

    await act(async () => {
      await app.refreshVoice();
    });

    expect(ipc.invoke).toHaveBeenCalledWith('voice_status');
    expect(ipc.invoke).toHaveBeenCalledWith('audio_devices');
    expect(app.audioDevices).toEqual(sampleDevices);
  });

  it('saves chosen audio devices locally without sending to remote server', async () => {
    let savedPayload: Settings | undefined;
    ipc.invoke.mockImplementation(async (command: string, args?: { settings?: Settings }) => {
      if (command === 'load_settings') return { settings, data_root: '', global_shortcuts: false, pc_access_available: false };
      if (command === 'save_settings') {
        savedPayload = args?.settings;
        return args?.settings;
      }
      return {};
    });
    await mount();

    await act(async () => {
      await app.saveVoice({
        input_device: 'USB Наушники Mic',
        output_device: 'USB Наушники Audio',
      });
    });

    expect(savedPayload?.voice?.input_device).toBe('USB Наушники Mic');
    expect(savedPayload?.voice?.output_device).toBe('USB Наушники Audio');
    // Ensure no bridge/api/websocket calls transmitted device preferences to server
    const remoteCalls = ipc.invoke.mock.calls.filter(([name]) => name === 'api' || name === 'bridge_message');
    expect(remoteCalls).toHaveLength(0);
  });

  it('renders VoicePanel device selectors with fallback for unplugged device', () => {
    const onSave = vi.fn();
    const testVoice = {
      ...defaultVoice,
      input_device: 'Старый микрофон',
      output_device: 'USB Наушники Audio',
    };

    let panelRenderer!: ReactTestRenderer;
    act(() => {
      panelRenderer = create(
        <VoicePanel
          voice={testVoice}
          root="/test-root"
          busy={false}
          shortcuts={true}
          audioDevices={sampleDevices}
          onDraft={vi.fn()}
          onSave={onSave}
          onRefresh={vi.fn()}
        />,
      );
    });

    const selects = panelRenderer.root.findAllByType('select');
    const inputSelect = selects.find(s => s.props.name === 'voice-input-device');
    const outputSelect = selects.find(s => s.props.name === 'voice-output-device');

    expect(inputSelect).toBeDefined();
    expect(outputSelect).toBeDefined();

    // Check options in inputSelect
    const inputOptions = inputSelect!.findAllByType('option');
    expect(inputOptions[0].props.value).toBe('');
    expect(inputOptions[0].children.join('')).toContain('По умолчанию (Встроенный микрофон)');
    expect(inputOptions.some(o => o.props.value === 'Встроенный микрофон')).toBe(true);
    // Missing device should be listed as disconnected fallback
    const missingInputOpt = inputOptions.find(o => o.props.value === 'Старый микрофон');
    expect(missingInputOpt).toBeDefined();
    expect(missingInputOpt!.children.join('')).toContain('Старый микрофон (не подключено, fallback на системный)');

    // Check options in outputSelect
    const outputOptions = outputSelect!.findAllByType('option');
    expect(outputOptions[0].props.value).toBe('');
    expect(outputOptions[0].children.join('')).toContain('По умолчанию (Встроенные динамики)');
    expect(outputOptions.some(o => o.props.value === 'USB Наушники Audio')).toBe(true);

    // Changing selection triggers onSave
    act(() => {
      inputSelect!.props.onChange({ target: { value: 'USB Наушники Mic' } });
    });
    expect(onSave).toHaveBeenCalledWith({ input_device: 'USB Наушники Mic' });

    act(() => {
      outputSelect!.props.onChange({ target: { value: '' } });
    });
    expect(onSave).toHaveBeenCalledWith({ output_device: '' });

    const paragraphs = panelRenderer.root.findAllByType('p');
    const noticeP = paragraphs.find(p => p.children.join('').includes('следующем открытии записи или воспроизведения'));
    expect(noticeP).toBeDefined();
    expect(noticeP!.children.join('')).toBe('Выбор устройства сохраняется только на этом ПК и не передаётся на сервер. Если выбранного устройства нет при следующем открытии записи или воспроизведения, используется системное устройство по умолчанию.');
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
