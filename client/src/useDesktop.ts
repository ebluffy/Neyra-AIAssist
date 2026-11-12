import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { bindProfileSession, ensureSessionId, firstServerSession, mergeHistory, isUuid, nextId, profileSessionRepair, selectedProfile, sessionOrNew, storedThreads, stripAudio, switchThread, threadTitle, wavBlob, type ChatMessage, type ChatThread } from './chat';
import { type DraftEvent, type RunEvent, describeRun } from './commands';
import { type SheetId, themeId } from './theme';
import { createTokenBatch } from './streaming';
import { acceptLiveRun, conversionNotice, defaultVoice, emptyAudioDevices, formatError, meterLevel, settleLiveStart, unwrapApi, type AudioDevices, type Device, type Entry, type HostCall, type LiveState, type Plugin, type Profile, type Recovery, type ServerEvent, type Settings, type VoiceSettings, type VoiceStatus, validServerUrl } from './types';

const authError = 'Токен отклонён сервером. Проверьте токен профиля и подключитесь снова.';
const revokedError = 'Сеанс отключён с сервера. Нажмите «Подключить», чтобы войти снова.';
// Notices that belong to "processing a clip"; a cancelled capture must not leave them.
const PROCESSING_NOTICES = ['Распознаю речь…', 'Запись завершена: лимит 30 секунд.'];

// Codes this client raises itself (audio.rs, lib.rs). Nothing else is treated as local,
// so a server error that happens to start with "audio_" is still shown as a server error.
const LOCAL_AUDIO_ERRORS: Record<string, string> = {
  audio_unavailable: 'Проверьте аудиоустройство.',
  audio_fallback: 'Выбранное устройство вывода недоступно — звук идёт через системное.',
  audio_backpressure: 'Очередь озвучки переполнена, ответ показан текстом.',
  audio_invalid: 'Не удалось воспроизвести ответ, текст показан в чате.',
  microphone_unavailable: 'Проверьте микрофон и его разрешение в системе.',
  wake_failed: 'Прослушивание по слову не запустилось, проверьте микрофон.',
  voice_unavailable: 'Голосовое соединение потеряно, повторите попытку.',
  no_capture: 'Запись не шла, нажмите и удерживайте кнопку заново.',
  empty_capture: 'Запись пустая, повторите.',
  turn_busy: 'Дождитесь ответа или нажмите Stop.',
  already_recording: 'Запись уже идёт.',
  live_active: 'Сначала остановите разговор голосом.',
  internal_error: 'Внутренняя ошибка состояния, повторите попытку.',
};

export function localErrorText(code: string): string | undefined {
  const hint = LOCAL_AUDIO_ERRORS[code];
  return hint ? `Ошибка звука: ${code}. ${hint}` : undefined;
}

export function useDesktop() {
  const [settings, setSettings] = useState<Settings>();
  const [root, setRoot] = useState('');
  const [shortcuts, setShortcuts] = useState(false);
  const [pcAvailable, setPcAvailable] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [connected, setConnected] = useState(false);
  const [connectionWanted, setConnectionWanted] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeSticky, setNoticeSticky] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [platform, setPlatform] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [partial, setPartial] = useState('');
  const [lastTrace, setLastTrace] = useState<unknown>();
  const [tokenBatch] = useState(() => createTokenBatch(setPartial));
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [active, setActive] = useState(false);
  const [hostCall, setHostCall] = useState<HostCall>();
  const [devices, setDevices] = useState<Device[]>([]);
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState<unknown>();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [token, setToken] = useState('');
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [draft, setDraft] = useState<DraftEvent>();
  const [runLine, setRunLine] = useState('');
  const [commandRunning, setCommandRunning] = useState(false);
  const [backends, setBackends] = useState({ screen: false, input: false });
  const [liveState, setLiveState] = useState<LiveState>('off');
  const [micLevel, setMicLevel] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>();
  const [audioDevices, setAudioDevices] = useState<AudioDevices>(emptyAudioDevices);
  const [liveOpen, setLiveOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState('');
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const hydrated = useRef(false);
  const chatsReady = useRef(false);
  const muteHold = useRef(false);
  // The UI owns this ID before IPC starts; Rust uses it unchanged on the bridge.
  const chatTurn = useRef<{ id: string; ipcPending: boolean; terminal: boolean } | null>(null);
  const liveRun = useRef(0);
  const liveEpoch = useRef(0);
  const captureTerminalError = useRef<string | null>(null);
  const captureId = useRef(0);
  const captureStopping = useRef(false);
  // Only the code that really ends a capture sets it: release commits, Stop/cancel
  // discard. Foreign events (speaking, done, error of an earlier answer) must not
  // decide the fate of a clip that is being opened.
  const captureIntent = useRef<'commit' | 'cancel' | null>(null);
  const captureStarting = useRef(false);
  const lastVoiceClipRequestId = useRef<string | null>(null);
  const keepLocal = useRef(false);
  const historyStamp = useRef(0);
  const savedSettings = useRef<Settings | undefined>(undefined);
  const urls = useRef<string[]>([]);
  const profile = settings?.profiles.find(item => item.id === profileId);
  const voice: VoiceSettings = settings?.voice ?? defaultVoice;
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice(''); setNoticeSticky(false);
    try { await action(); } catch (reason) { setError(formatError(reason)); } finally { setBusy(false); }
  }, []);
  const postNotice = (message: string, sticky = false) => { setNotice(message); setNoticeSticky(sticky); setError(''); };
  const notify = useCallback((message: string) => { setNotice(message); setNoticeSticky(false); setError(''); }, []);
  // Both the button and the 30s limit enter processing before IPC can emit events.
  const clearProcessingNotice = () => setNotice(current => (PROCESSING_NOTICES.includes(current) ? '' : current));
  const finishCapture = useCallback(async (limited = false) => {
    if (captureStopping.current) return;
    captureStopping.current = true;
    captureIntent.current = 'commit';
    const capture = captureId.current;
    setRecording(false); setThinking(true);
    setNotice(limited ? 'Запись завершена: лимит 30 секунд.' : 'Распознаю речь…');
    setNoticeSticky(limited); setError('');
    // The device is still opening: beginRecording commits or cancels as soon as it resolves.
    if (captureStarting.current) return;
    try { await invoke('record_stop'); }
    catch (reason) {
      if (captureId.current !== capture || (captureIntent.current as 'commit' | 'cancel' | null) === 'cancel') return;
      setThinking(false);
      clearProcessingNotice();
      setError(captureTerminalError.current ?? formatError(reason));
    } finally {
      if (captureId.current === capture) setRecording(false);
    }
    // Acknowledgement never replaces a terminal event or the next capture's state.
  }, []);
  const dismissNotice = useCallback(() => { setNotice(''); setNoticeSticky(false); }, []);
  const openSheet = useCallback((id: SheetId) => { setMenuOpen(false); setSheet(id); }, []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    if (!connectionWanted || connected) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke('connect', { profileId: connectionWanted }).then(async () => {
        if (cancelled) return;
        setConnected(true); setRetry(0); setError('');
        // Local rows are reconciled by identity in the history handler. Always
        // refresh after reconnect to include turns persisted while we were offline.
        try { await invoke('bridge_message', { kind: 'history' }); }
        catch { setError('Не удалось загрузить историю. Повторите запрос после подключения.'); }
        try { await invoke('bridge_message', { kind: 'devices' }); }
        catch { setError('Не удалось загрузить список устройств. Повторите запрос.'); }
      }).catch(reason => {
        if (cancelled) return;
        setConnected(false); setThinking(false);
        if (reason === 'AUTH_REJECTED') {
          setConnectionWanted(''); setError(authError); return;
        }
        if (typeof reason === 'string' && reason.startsWith('CONFIG_ERROR: ')) {
          setConnectionWanted(''); setError(formatError(reason.slice('CONFIG_ERROR: '.length))); return;
        }
        setError(`Нет связи. Повторное подключение автоматически. ${formatError(reason)}`);
        setRetry(value => value + 1);
      });
    }, retry === 0 ? 0 : Math.min(1000 * 2 ** Math.min(retry - 1, 5), 30000));
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connectionWanted, connected, retry]);
  useEffect(() => {
    if (!notice || noticeSticky) return;
    const timer = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(timer);
  }, [notice, noticeSticky]);

  useEffect(() => {
    void invoke<{ settings: Settings; data_root: string; platform?: string; version?: string; global_shortcuts: boolean; pc_access_available: boolean; recoveries?: Recovery[]; screen_backend?: boolean; input_backend?: boolean }>('load_settings').then(async data => {
      setRoot(data.data_root); setPlatform(data.platform ?? ''); setAppVersion(data.version || '0.1.0'); setShortcuts(data.global_shortcuts); setPcAvailable(data.pc_access_available); setRecoveries(data.recoveries ?? []);
      setBackends({ screen: !!data.screen_backend, input: !!data.input_backend });
      let stored: ChatThread[] = [];
      try {
        const rows = await invoke<ChatThread[] | { threads?: ChatThread[]; recovery?: Recovery }>('load_chats');
        if (Array.isArray(rows)) stored = rows;
        else {
          stored = Array.isArray(rows?.threads) ? rows.threads : [];
          if (rows?.recovery) setRecoveries(list => [...list, rows.recovery as Recovery]);
        }
        chatsReady.current = true;
      } catch (reason) { setError(formatError(reason)); }
      const selected = selectedProfile(data.settings.profiles, data.settings.active_profile);
      const sessionId = sessionOrNew(selected?.session_id, stored);
      const repaired = profileSessionRepair(selected?.session_id, sessionId);
      const nextSettings = repaired && selected
        ? { ...data.settings, profiles: data.settings.profiles.map(item => item.id === selected.id ? { ...item, session_id: repaired } : item) }
        : data.settings;
      if (repaired) {
        try { await invoke('save_settings', { settings: nextSettings }); }
        catch (reason) { setError(formatError(reason)); }
      }
      savedSettings.current = nextSettings;
      setSettings(nextSettings);
      setProfileId(selected?.id ?? '');
      const match = stored.find(item => item.sessionId === sessionId);
      const thread = match ?? { id: nextId(), title: 'Новый чат', sessionId, updated: Date.now(), messages: [] as ChatMessage[] };
      const list = match ? stored : [thread, ...stored].slice(0, 30);
      hydrated.current = true;
      setThreads(list);
      setActiveId(thread.id);
      setMessages(thread.messages);
    }).catch(reason => setError(formatError(reason)));
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await invoke<{ settings: { auto_check: boolean }; key_configured: boolean }>('update_state');
        if (!live || !next.settings.auto_check || !next.key_configured) return;
        const result = await invoke<{ available: boolean; version?: string }>('update_check');
        if (!live || !result.available) return;
        setNotice(result.version ? `Доступна версия ${result.version}. Откройте раздел «Обновления».` : 'Доступно обновление. Откройте раздел «Обновления».');
        setNoticeSticky(true);
        setError('');
      } catch { /* A failed startup check stays quiet; the updates section can retry. */ }
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!hydrated.current || !activeId) return;
    setThreads(prev => {
      if (!prev.some(item => item.id === activeId)) return prev;
      return prev.map(item => item.id === activeId ? { ...item, messages: messages.map(stripAudio), title: threadTitle(messages), updated: messages.length === item.messages.length ? item.updated : Date.now() } : item);
    });
  }, [messages, activeId]);
  useEffect(() => {
    if (!chatsReady.current) return;
    void invoke('save_chats', { threads: storedThreads(threads) }).catch(reason => setError(formatError(reason)));
  }, [threads]);
  useEffect(() => {
    const live = new Set(messages.flatMap(item => item.audioUrl ? [item.audioUrl] : []));
    urls.current = urls.current.filter(url => {
      if (live.has(url)) return true;
      URL.revokeObjectURL(url);
      return false;
    });
  }, [messages]);

  useEffect(() => {
    let mounted = true;
    const listeners = [
      listen<ServerEvent>('desktop-event', ({ payload: event }) => {
        if (!mounted) return;
        const gate = acceptLiveRun(liveRun.current, event);
        liveRun.current = gate.current;
        if (!gate.accept) return;
        if (event.source === 'bridge' && event.request_id) {
          const turn = chatTurn.current;
          if (!turn || turn.id !== event.request_id || turn.terminal) return;
        }
        const affectsText = !chatTurn.current || event.source === 'bridge' || event.scope === 'all';
        if (event.type === 'hello') setConnected(true);
        if (event.type === 'token') tokenBatch.push(event.text ?? '');
        if (event.type === 'done') {
          if (affectsText && event.source !== 'voice' && chatTurn.current) {
            chatTurn.current.terminal = true;
            if (!chatTurn.current.ipcPending) chatTurn.current = null;
          }
          setLastTrace(event.model_trace);
          setMessages(list => {
            const requestId = event.source === 'bridge' ? event.request_id : undefined;
            const index = requestId ? list.findIndex(row => row.role === 'assistant' && row.requestId === requestId) : -1;
            if (index >= 0) return list.map((row, i) => i === index ? { ...row, content: event.text ?? '' } : row);
            return [...list.slice(-99), { id: nextId(), role: 'assistant', content: event.text ?? '', kind: 'text', requestId }];
          });
          if (affectsText) { tokenBatch.reset(); setThinking(event.source === 'voice'); }
          postNotice(event.source === 'voice' ? 'Готовлю озвучку…' : 'Ответ готов');
        }
        if (event.type === 'history') {
          historyStamp.current += 1;
          const incoming = (event.messages ?? []).map((entry: Entry) => ({ id: nextId(), role: entry.role, content: entry.content, kind: 'text' as const, serverId: entry.id != null && /^[0-9]+$/.test(String(entry.id)) ? String(entry.id) : undefined, turnId: entry.turn_id, requestId: entry.request_id }));
          setMessages(local => keepLocal.current ? mergeHistory(incoming, local) : incoming);
        }
        if (event.type === 'devices') setDevices(event.devices ?? []);
        if (event.type === 'voice.clip') {
          if (typeof event.request_id === 'string' && event.request_id) {
            lastVoiceClipRequestId.current = event.request_id;
          }
          if (event.audio) {
            try {
              const url = URL.createObjectURL(wavBlob(event.audio));
              urls.current.push(url);
              setMessages(list => [...list.slice(-99), { id: nextId(), role: 'user', content: '', kind: 'voice', audioUrl: url, durationMs: event.duration_ms, pending: true }]);
            } catch { setError('Не удалось показать запись'); }
          }
        }
        if (event.type === 'transcript.final') {
          const spoken = event.text ?? '';
          setMessages(list => {
            const index = [...list].reverse().findIndex(item => item.role === 'user' && item.kind === 'voice' && item.pending);
            if (index === -1) return [...list.slice(-99), { id: nextId(), role: 'user', content: spoken, kind: 'text' }];
            const real = list.length - 1 - index;
            return list.map((item, itemIndex) => itemIndex === real ? { ...item, content: spoken, pending: false } : item);
          });
          postNotice('Речь распознана');
        }
        if (event.type === 'pc_access') setPcAvailable(event.available ?? false);
        if (event.type === 'audio.finished') { postNotice('Озвучка завершена'); setLiveState(state => state === 'off' ? state : 'idle'); }
        // Invariant: 'recording' is emitted exclusively by the global hotkey handler (lib.rs:setup_shortcuts)
        // after its own record_start succeeds. UI beginRecording invokes record_start directly and never emits
        // 'recording'. Since Desktop.recording is a single Mutex<Option<Recording>> slot in Rust, two record_start
        // calls cannot both succeed; one always returns AlreadyRecording. Thus, a 'recording' event can never
        // interleave with a successful UI beginRecording session.
        if (event.type === 'recording') { captureTerminalError.current = null; lastVoiceClipRequestId.current = null; captureId.current += 1; captureStopping.current = false; captureIntent.current = null; setRecording(true); setThinking(false); }
        if (event.type === 'transcribing') { setRecording(false); setThinking(true); setLiveState(state => state === 'off' ? state : 'thinking'); }
        if (event.type === 'speaking') { setThinking(false); setLiveState(state => state === 'off' ? state : 'speaking'); postNotice('Нейра говорит. Стоп прервёт озвучку.'); }
        if (event.type === 'live.started') { setLiveOpen(true); setMuted(false); setLiveState('idle'); }
        if (event.type === 'live.stopped') { setLiveState('off'); setMicLevel(0); if (!muteHold.current) { setLiveOpen(false); setMuted(false); } }
        if (event.type === 'live.idle') setLiveState(state => state === 'off' ? state : 'idle');
        if (event.type === 'wake') setLiveState('armed');
        if (event.type === 'listening') { tokenBatch.reset(); setLiveState('listening'); }
        if (event.type === 'mic.level') setMicLevel(meterLevel(event.db ?? -100));
        if (event.type === 'status' && event.state === 'thinking') setLiveState(state => state === 'off' ? state : 'thinking');
        if (event.type === 'status' && event.state === 'slow') postNotice('Провайдер отвечает медленно, я ещё думаю…');
        if (event.type === 'status' && event.state === 'truncated') postNotice('Ответ длинный: озвучено только начало, полный текст в чате.', true);
        if (event.type === 'voice.conversion') { const text = conversionNotice(event.status, event.code); if (text) postNotice(text, true); }
        if (event.type === 'disconnected') {
          chatTurn.current = null;
          captureId.current += 1;
          captureStopping.current = true;
          captureIntent.current = 'cancel';
          muteHold.current = false; setLiveOpen(false); setMuted(false); setLiveState('off'); setRetry(1); setConnected(false); setBusy(false); setThinking(false); setRecording(false); setActive(false); setHostCall(undefined); tokenBatch.reset();
          if (event.reason === 'auth') { setConnectionWanted(''); setNotice(''); setError(revokedError); }
          else postNotice('Нет связи. Ответ мог не дойти. Проверьте историю перед повторной отправкой.', true);
        }
        if (event.type === 'error') {
          // A failed player/wake/previous answer is not this capture's stop: keeping
          // captureStopping here froze PTT and the 30s limit while the mic kept running.
          const code = typeof event.code === 'string' && event.code ? event.code : 'ошибка';
          const message = localErrorText(code) ?? `Сервер: ${code}. Повторите попытку.`;
          // Only a turn-scoped error can belong to this commit: playback and quick-command
          // errors arrive without a request_id and must never replace the capture reason.
          if (captureStopping.current && captureIntent.current === 'commit' && typeof event.request_id === 'string' && event.request_id && event.request_id === lastVoiceClipRequestId.current) captureTerminalError.current = message;
          setError(message);
          if (affectsText) { chatTurn.current = null; setThinking(false); tokenBatch.reset(); }
          setLiveState(state => state === 'thinking' ? 'idle' : state);
        }
        if (event.type === 'capture.failed') {
          const message = localErrorText(event.code ?? '') ?? formatError(event.code);
          // A failed shortcut start did not acquire or release the recording slot.
          if (event.stage === 'start') { setError(message); return; }
          captureTerminalError.current = message;
          captureId.current += 1;
          captureStopping.current = true;
          captureIntent.current = 'cancel';
          setRecording(false); setThinking(false);
          clearProcessingNotice();
          setError(message);
        }
        if (event.type === 'cancelled') {
          captureId.current += 1;
          captureStopping.current = true;
          captureIntent.current = 'cancel';
          if (affectsText) { chatTurn.current = null; setThinking(false); tokenBatch.reset(); }
          setRecording(false); setActive(false); setHostCall(undefined); postNotice('Остановлено');
          if (event.reason !== 'barge_in') { muteHold.current = false; setLiveOpen(false); setMuted(false); }
        }
      }),
      listen<HostCall>('host-confirm', ({ payload }) => { setHostCall(payload); setMenuOpen(false); setSheet(null); setHistoryOpen(false); }),
      listen<{ call_id?: string }>('host-confirm-closed', ({ payload }) => {
        setHostCall(current => (current && (!payload.call_id || current.call_id === payload.call_id) ? undefined : current));
      }),
      listen<{ active: boolean }>('host-activity', ({ payload }) => setActive(payload.active)),
      listen<RunEvent>('command-run', ({ payload }) => {
        setRunLine(describeRun(payload)); setCommandRunning(payload.state === 'started' || payload.state === 'step'); setThinking(false);
        if (payload.state === 'failed') setError(describeRun(payload)); else postNotice(describeRun(payload), payload.state === 'finished' || payload.state === 'cancelled');
      }),
      listen<DraftEvent>('command-draft', ({ payload }) => { setDraft(payload); setMenuOpen(false); setSheet(null); setHistoryOpen(false); }),
      listen<{ reason: string }>('command-draft-invalid', ({ payload }) => setError(`Черновик команды отклонён: ${payload.reason}`)),
    ];
    return () => { mounted = false; chatTurn.current = null; tokenBatch.dispose(); for (const listener of listeners) void listener.then(unlisten => unlisten()); };
  }, [tokenBatch]);

  useEffect(() => {
    if (!hostCall) return;
    const timeout = window.setTimeout(() => setHostCall(undefined), Math.max(0, hostCall.deadline_ms - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [hostCall]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setTimeout(() => {
      void finishCapture(true);
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [recording, finishCapture]);

  const persistSaved = async (next: Settings) => {
    const previous = savedSettings.current;
    savedSettings.current = next;
    try { await invoke('save_settings', { settings: next }); }
    catch (reason) {
      if (savedSettings.current === next) savedSettings.current = previous;
      throw reason;
    }
  };
  const save = async (next: Settings) => { await persistSaved(next); setSettings(next); };
  const saveSection = async (patch: Partial<Settings>) => {
    const disk = savedSettings.current;
    if (!settings || !disk) return;
    setSettings({ ...settings, ...patch });
    try { await persistSaved({ ...disk, ...patch }); }
    catch (reason) { setSettings(settings); throw reason; }
  };
  const patchProfile = (patch: Partial<Profile>) => { if (settings && profile) setSettings({ ...settings, profiles: settings.profiles.map(item => item.id === profileId ? { ...item, ...patch } : item) }); };
  const request = async <T,>(path: string, method = 'GET') => unwrapApi<T>(await invoke<unknown>('api', { profileId, path, method }));
  const rememberLive = (runId: unknown) => { if (typeof runId === 'number') liveRun.current = runId; };
  const stop = () => run(async () => { chatTurn.current = null; captureId.current += 1; captureStopping.current = true; captureIntent.current = 'cancel'; setRecording(false); setThinking(false); tokenBatch.reset(); liveEpoch.current += 1; await invoke('stop'); setHostCall(undefined); setActive(false); setThinking(false); setRecording(false); muteHold.current = false; setLiveOpen(false); setMuted(false); setLiveState('off'); });
  const saveVoice = (patch: Partial<VoiceSettings>) => run(async () => {
    const disk = savedSettings.current;
    if (!settings || !disk) return;
    const nextVoice = { ...(settings.voice ?? disk.voice ?? defaultVoice), ...patch };
    setSettings({ ...settings, voice: nextVoice });
    try { await persistSaved({ ...disk, voice: nextVoice }); }
    catch (reason) { setSettings(settings); throw reason; }
    setLiveState('off');
  });
  const draftVoice = (patch: Partial<VoiceSettings>) => { if (settings) setSettings({ ...settings, voice: { ...voice, ...patch } }); };
  const refreshVoice = () => run(async () => {
    setVoiceStatus(await invoke<VoiceStatus>('voice_status'));
    try { setAudioDevices(await invoke<AudioDevices>('audio_devices')); } catch { /* ignore */ }
  });
  useEffect(() => {
    if (sheet === 'voice') {
      void (async () => {
        try { setVoiceStatus(await invoke<VoiceStatus>('voice_status')); } catch { /* ignore */ }
        try { setAudioDevices(await invoke<AudioDevices>('audio_devices')); } catch { /* ignore */ }
      })();
    }
  }, [sheet]);
  const finishLiveStart = async (epoch: number, id: number) => {
    const open = await settleLiveStart(epoch, liveEpoch.current, () => invoke('live_stop'));
    if (!open) return false;
    rememberLive(id);
    setMuted(false);
    return true;
  };
  const startLive = () => run(async () => {
    const epoch = liveEpoch.current;
    muteHold.current = false;
    if (await finishLiveStart(epoch, await invoke<number>('live_start'))) { setLiveOpen(true); setLiveState('idle'); }
  });
  const toggleMute = () => run(async () => {
    if (muted) {
      const epoch = liveEpoch.current;
      muteHold.current = false;
      await finishLiveStart(epoch, await invoke<number>('live_start'));
    }
    else { muteHold.current = true; await invoke('live_stop'); setMuted(true); setMicLevel(0); postNotice('Микрофон на паузе'); }
  });
  const endLive = () => run(async () => { chatTurn.current = null; captureId.current += 1; captureStopping.current = true; captureIntent.current = 'cancel'; setRecording(false); setThinking(false); tokenBatch.reset(); liveEpoch.current += 1; muteHold.current = false; await invoke('live_stop'); await invoke('stop'); setLiveOpen(false); setMuted(false); setMicLevel(0); setThinking(false); setLiveState('off'); postNotice('Разговор завершён'); });
  const settingsForServer = (current: Settings): Settings => {
    if (!profile) return current;
    const active = threads.find(item => item.id === activeId);
    const sessionId = ensureSessionId(active?.sessionId);
    if (active && active.sessionId !== sessionId) setThreads(list => list.map(item => item.id === active.id ? { ...item, sessionId } : item));
    return { ...current, active_profile: profile.id, profiles: bindProfileSession(current.profiles, profile.id, sessionId) };
  };
  const check = () => run(async () => {
    if (!settings || !profile || !validServerUrl(profile.url)) throw 'Укажите HTTPS-адрес или HTTP localhost.';
    await save(settingsForServer(settings));
    if (token) { await invoke('store_token', { profileId, token }); setToken(''); }
    const health = await request<{ api_version?: unknown }>('/v1/health');
    const version = typeof health?.api_version === 'string' ? health.api_version : '';
    if (!version.startsWith('1.')) throw 'Несовместимая версия API. Требуется 1.x.';
    setStatus(health); postNotice(`Сервер доступен · API ${version}`);
  });
  const connect = () => run(async () => {
    if (!settings || !profile || !validServerUrl(profile.url)) throw 'Сначала настройте сервер.';
    await save(settingsForServer(settings));
    if (token) { await invoke('store_token', { profileId, token }); setToken(''); }
    const active = threads.find(item => item.id === activeId);
    const preserve = messages.length > 0 || (active?.messages.length ?? 0) > 0;
    keepLocal.current = preserve;
    setRetry(0); setConnectionWanted(profile.id);
    if (!preserve) setMessages([]);
  });
  const disconnect = () => run(async () => { chatTurn.current = null; captureId.current += 1; captureStopping.current = true; captureIntent.current = 'cancel'; setRecording(false); setThinking(false); tokenBatch.reset(); setConnectionWanted(''); keepLocal.current = false; await invoke('disconnect'); setConnected(false); setThinking(false); setDevices([]); setTarget(''); });
  const sendContent = (value: string) => {
    // A ref also guards two submissions in the same render and pending quick commands.
    if (chatTurn.current || !value.trim()) return Promise.resolve();
    return run(async () => {
      const trimmed = value.trim();
      const turn = { id: crypto.randomUUID(), ipcPending: true, terminal: false };
      const userId = nextId();
      chatTurn.current = turn;
      // Reconcile late history with local rows instead of replacing the optimistic turn.
      keepLocal.current = true;
      setMessages(list => [...list, { id: userId, role: 'user', content: trimmed, kind: 'text', requestId: turn.id }]);
      tokenBatch.reset(); setThinking(true);
      let result: { handled: boolean; command?: string };
      try {
        const dispatchEpoch = await invoke<number>('chat_epoch');
        if (chatTurn.current !== turn) return;
        result = await invoke<typeof result>('chat', { text: trimmed, targetDeviceId: target || null, requestId: turn.id, dispatchEpoch });
      }
      catch (reason) {
        // Stop/disconnect or a terminal event owns the result once it has arrived.
        if (chatTurn.current !== turn) return;
        if (turn.terminal) {
          chatTurn.current = null;
          setText(current => current === value ? '' : current);
          return;
        }
        chatTurn.current = null;
        setMessages(list => list.filter(item => item.id !== userId));
        setText(current => current || value);
        tokenBatch.reset(); setThinking(false);
        throw `Сообщение не отправлено; текст сохранён. Повторите отправку после подключения. ${formatError(reason)}`;
      }
      if (chatTurn.current !== turn) return;
      turn.ipcPending = false;
      if (result?.handled) {
        chatTurn.current = null;
        setMessages(list => [...list.slice(-99), { id: nextId(), role: 'assistant', content: `Команда «${result.command}» запущена на этом ПК.`, kind: 'text' }]);
        setThinking(false);
      } else if (turn.terminal) chatTurn.current = null;
      else setMessages(list => list.slice(-100));
      // IPC acknowledgement must never restart thinking after an early WSS terminal.
      setText(current => current === value ? '' : current);
    });
  };
  const decideDraft = (accepted: boolean, item: DraftEvent) => run(async () => { setDraft(undefined); if (accepted) { await invoke('draft_confirm', { draftId: item.draft_id }); postNotice('Команда сохранена на этом ПК', true); } else await invoke('draft_reject', { draftId: item.draft_id }); });
  const beginRecording = () => run(async () => {
    captureTerminalError.current = null;
    // A clip of a previous turn must never look like this capture's own clip.
    lastVoiceClipRequestId.current = null;
    const currentCapture = ++captureId.current;
    captureStopping.current = false;
    captureIntent.current = null;
    captureStarting.current = true;
    try {
      await invoke('record_start');
    } catch (reason) {
      captureStarting.current = false;
      setRecording(false);
      setThinking(false);
      clearProcessingNotice();
      if (!captureStopping.current) throw reason;
      return;
    }
    captureStarting.current = false;
    // A foreign event during the IPC call must not hide a capture that is really running.
    if (!captureStopping.current) { setRecording(true); setThinking(false); return; }
    // The button was released (commit) or Stop/disconnect/cancel fired (discard) while
    // the device was opening; only that intent decides, not a shared event counter.
    const released = captureIntent.current === 'commit';
    if (!released) {
      try {
        await invoke('record_cancel');
        if (captureId.current === currentCapture) postNotice('Запись отменена');
      } catch (reason) {
        if (captureId.current === currentCapture) setError(formatError(reason));
      } finally {
        if (captureId.current === currentCapture) {
          setRecording(false);
          setThinking(false);
          clearProcessingNotice();
        }
      }
      return;
    }
    try { await invoke('record_stop'); }
    catch (reason) {
      if (captureId.current !== currentCapture || (captureIntent.current as 'commit' | 'cancel' | null) === 'cancel') return;
      setRecording(false);
      setThinking(false);
      clearProcessingNotice();
      setError(captureTerminalError.current ?? formatError(reason));
    }
  });
  const finishRecording = () => run(() => finishCapture());
  const cancelRecording = () => run(async () => {
    const capture = captureId.current;
    captureStopping.current = true;
    captureIntent.current = 'cancel';
    setThinking(false);
    clearProcessingNotice();
    if (captureStarting.current) {
      setRecording(false);
      return;
    }
    try {
      await invoke('record_cancel');
      if (captureId.current === capture) postNotice('Запись отменена');
    } catch (reason) {
      if (captureId.current === capture) setError(formatError(reason));
    } finally {
      if (captureId.current === capture) setRecording(false);
    }
  });
  const copyText = (value: string) => { void navigator.clipboard.writeText(value).then(() => { postNotice('Скопировано'); }).catch(() => setError('Не удалось скопировать')); };
  const speak = (value: string) => run(async () => {
    const spoken = [...value.trim()].slice(0, 300).join('');
    if (!spoken) return;
    await invoke('speak_text', { text: spoken });
    postNotice(spoken.length < value.trim().length ? 'Озвучено начало ответа: голос принимает до 300 символов.' : 'Озвучиваю ответ', spoken.length < value.trim().length);
  });
  const approve = (allow: boolean) => run(async () => { if (hostCall) { const id = hostCall.call_id; setHostCall(undefined); await invoke('approve', { callId: id, allow }); } });
  const setTheme = (nextTheme: string) => run(async () => {
    const disk = savedSettings.current;
    if (!settings || !disk) return;
    setSettings({ ...settings, theme: nextTheme });
    try { await persistSaved({ ...disk, theme: nextTheme }); }
    catch (reason) { setSettings(settings); throw reason; }
  });
  const blockSwitch = () => {
    if (liveOpen) return false;
    if (thinking || partial || recording || active || hostCall || draft) throw 'Сначала остановите текущий ход кнопкой «Стоп»';
    return true;
  };
  const switchSession = async (sessionId: string, preserveMessages: boolean) => {
    const disk = savedSettings.current;
    if (!settings || !disk || !profile) return;
    const diskProfile = disk.profiles.find(item => item.id === profile.id);
    if (!diskProfile || diskProfile.session_id === sessionId) return;
    const previousId = diskProfile.session_id;
    const withSession = (base: Settings, id: string): Settings => ({ ...base, profiles: base.profiles.map(item => item.id === profile.id ? { ...item, session_id: id } : item) });
    setSettings(withSession(settings, sessionId));
    try { await persistSaved(withSession(disk, sessionId)); }
    catch (reason) { setSettings(settings); throw reason; }
    if (!connected) return;
    try {
      await invoke('disconnect');
      setConnected(false);
      await invoke('connect', { profileId: profile.id });
      setConnected(true);
      await invoke('bridge_message', { kind: 'devices' });
      keepLocal.current = preserveMessages;
      await invoke('bridge_message', { kind: 'history' });
    } catch (reason) {
      try {
        keepLocal.current = true;
        setSettings(withSession(settings, previousId));
        await persistSaved(withSession(disk, previousId));
        await invoke('disconnect');
        await invoke('connect', { profileId: profile.id });
        setConnected(true);
        await invoke('bridge_message', { kind: 'devices' });
      } catch { setConnected(false); }
      throw reason;
    }
  };
  const newChat = () => run(async () => {
    if (!blockSwitch()) return;
    const sessionId = crypto.randomUUID();
    const fresh: ChatThread = { id: nextId(), title: 'Новый чат', sessionId, updated: Date.now(), messages: [] };
    const saved = threads.map(item => item.id === activeId ? { ...item, messages: messages.map(stripAudio), title: threadTitle(messages), updated: Date.now() } : item);
    await switchSession(sessionId, true);
    setThreads([fresh, ...saved].slice(0, 30));
    setActiveId(fresh.id);
    setMessages([]);
    tokenBatch.reset(); setHistoryOpen(false); setMenuOpen(false);
  });
  const openThread = (id: string) => run(async () => {
    if (!blockSwitch()) return;
    const switched = switchThread(threads, activeId, messages, id);
    if (!switched) { setHistoryOpen(false); return; }
    const target = switched.threads.find(item => item.id === switched.activeId);
    const sessionId = ensureSessionId(target?.sessionId);
    const nextThreads = target && target.sessionId !== sessionId ? switched.threads.map(item => item.id === target.id ? { ...item, sessionId } : item) : switched.threads;
    const hadMessages = !!(target && target.messages.length > 0);
    const beforeHistory = historyStamp.current;
    // History can arrive before connect's IPC reply. Reconcile against the
    // target thread's cache, and persist updates to that thread, not the old one.
    setThreads(nextThreads);
    setActiveId(switched.activeId);
    setMessages(switched.messages);
    try { await switchSession(sessionId, hadMessages); }
    catch (reason) {
      setThreads(threads); setActiveId(activeId); setMessages(messages);
      throw reason;
    }
    if (historyStamp.current === beforeHistory) setMessages(switched.messages);
    tokenBatch.reset(); setHistoryOpen(false);
  });
  const addProfile = (created: Profile) => {
    const disk = savedSettings.current;
    if (!settings || !disk) return;
    if (connectionWanted || connected) void disconnect();
    const active = threads.find(item => item.id === activeId);
    const sessionId = firstServerSession(disk.profiles.length > 0, created.session_id, active?.sessionId);
    if (disk.profiles.length === 0 && active && active.sessionId !== sessionId) setThreads(list => list.map(item => item.id === active.id ? { ...item, sessionId } : item));
    const profile = { ...created, session_id: sessionId };
    const saved = { ...disk, active_profile: created.id, profiles: [...disk.profiles, profile] };
    setSettings({ ...settings, active_profile: created.id, profiles: [...settings.profiles, profile] });
    setProfileId(created.id);
    setToken('');
    void persistSaved(saved).catch(reason => setError(formatError(reason)));
  };
  const chooseProfile = (id: string) => {
    if (id !== profileId && (connectionWanted || connected)) void disconnect();
    setProfileId(id);
    setToken('');
    setStatus(undefined);
    const disk = savedSettings.current;
    if (!settings || !disk) return;
    const active = threads.find(item => item.id === activeId);
    const bind = (list: Settings['profiles']) => active && isUuid(active.sessionId) ? bindProfileSession(list, id, active.sessionId) : list;
    setSettings({ ...settings, active_profile: id, profiles: bind(settings.profiles) });
    void persistSaved({ ...disk, active_profile: id, profiles: bind(disk.profiles) }).catch(reason => setError(formatError(reason)));
  };
  const refreshStatus = () => run(async () => { const out = await request<unknown>('/v1/health'); setStatus(out); });
  const refreshPlugins = () => run(async () => { const out = await request<{ plugins?: Plugin[] }>('/v1/plugins'); setPlugins(Array.isArray(out?.plugins) ? out.plugins : []); });
  const restartCore = () => { if (window.confirm('Перезапустить ядро сервера? Активные ходы прервутся.')) void run(async () => { await request('/v1/system/restart', 'POST'); postNotice('Запрошен мягкий рестарт', true); }); };
  const togglePlugin = (plugin: Plugin) => { if (window.confirm('Изменить состояние модуля? Для resident ядро будет перезапущено.')) void run(async () => { await invoke('set_module', { profileId, moduleId: plugin.id, enabled: !plugin.enabled }); setPlugins(list => list.map(item => item.id === plugin.id ? { ...item, enabled: !item.enabled } : item)); }); };
  const refreshDevices = () => run(async () => { await invoke('bridge_message', { kind: 'devices' }); });
  const disconnectDevice = () => { if (window.confirm('Отключить выбранный ПК? Действия будут отменены, повторное подключение выполняется на том ПК вручную.')) void run(async () => { await invoke('disconnect_device', { deviceId: target }); setTarget(''); }); };

  return {
    settings, setSettings, root, shortcuts, pcAvailable, profileId, profile, connected, busy, error, notice, noticeSticky, appVersion, platform, messages, partial, lastTrace, text, setText, thinking, recording, active, hostCall, devices, target, setTarget, status, plugins, token, setToken, recoveries, draft, runLine, commandRunning, backends, liveState, micLevel, voiceStatus, audioDevices, voice, liveOpen, muted, threads, activeId, sheet, menuOpen, historyOpen, theme: themeId(settings?.theme),
    run, notify, dismissNotice, save, saveSection, patchProfile, openSheet, closeSheet, closeMenu, setMenuOpen, setHistoryOpen, stop, saveVoice, draftVoice, refreshVoice, startLive, toggleMute, endLive, check, connect, disconnect, sendContent, decideDraft, beginRecording, finishRecording, cancelRecording, copyText, speak, approve, setTheme, newChat, openThread, addProfile, chooseProfile, refreshStatus, refreshPlugins, refreshDevices, restartCore, togglePlugin, disconnectDevice, setSheet,
  };
}
