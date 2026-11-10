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
      await event('error', { code: 'voice_failed' });
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

  it('does not send a second record_stop when the limit expires during manual IPC', async () => {
    await mount();
    const ipcStop = defer();
    const pending = await startStop('manual');
    await tick(30000);
    expect(ipc.invoke.mock.calls.filter(([name]) => name === 'record_stop')).toHaveLength(1);
    await act(async () => { ipcStop.resolve(); });
    await pending.settle();
  });
});
