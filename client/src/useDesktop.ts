import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { bindProfileSession, ensureSessionId, firstServerSession, isUuid, nextId, profileSessionRepair, selectedProfile, sessionOrNew, storedThreads, stripAudio, switchThread, threadTitle, wavBlob, type ChatMessage, type ChatThread } from './chat';
import { type DraftEvent, type RunEvent, describeRun } from './commands';
import { type SheetId, themeId } from './theme';
import { acceptLiveRun, conversionNotice, defaultVoice, formatError, meterLevel, unwrapApi, type Device, type Entry, type HostCall, type LiveState, type Plugin, type Profile, type Recovery, type ServerEvent, type Settings, type VoiceSettings, type VoiceStatus, validServerUrl } from './types';

export function useDesktop() {
  const [settings, setSettings] = useState<Settings>();
  const [root, setRoot] = useState('');
  const [shortcuts, setShortcuts] = useState(false);
  const [pcAvailable, setPcAvailable] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeSticky, setNoticeSticky] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [platform, setPlatform] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [partial, setPartial] = useState('');
  const [lastTrace, setLastTrace] = useState<unknown>();
  const tokenBuffer = useRef('');
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
  const liveRun = useRef(0);
  const keepLocal = useRef(false);
  const historyStamp = useRef(0);
  const urls = useRef<string[]>([]);
  const profile = settings?.profiles.find(item => item.id === profileId);
  const voice: VoiceSettings = settings?.voice ?? defaultVoice;
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice(''); setNoticeSticky(false);
    try { await action(); } catch (reason) { setError(formatError(reason)); } finally { setBusy(false); }
  }, []);
  const postNotice = (message: string, sticky = false) => { setNotice(message); setNoticeSticky(sticky); setError(''); };
  const notify = useCallback((message: string) => { setNotice(message); setNoticeSticky(false); setError(''); }, []);
  const dismissNotice = useCallback(() => { setNotice(''); setNoticeSticky(false); }, []);
  const openSheet = useCallback((id: SheetId) => { setMenuOpen(false); setSheet(id); }, []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
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
    const timer = window.setInterval(() => setPartial(tokenBuffer.current), 60);
    return () => window.clearInterval(timer);
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
    const listeners = [
      listen<ServerEvent>('desktop-event', ({ payload: event }) => {
        const gate = acceptLiveRun(liveRun.current, event);
        liveRun.current = gate.current;
        if (!gate.accept) return;
        if (event.type === 'hello') setConnected(true);
        if (event.type === 'token') tokenBuffer.current += event.text ?? '';
        if (event.type === 'done') {
          setLastTrace(event.model_trace);
          setMessages(list => [...list.slice(-99), { id: nextId(), role: 'assistant', content: event.text ?? '', kind: 'text' }]);
          tokenBuffer.current = ''; setPartial(''); setThinking(event.source === 'voice'); postNotice(event.source === 'voice' ? 'Готовлю озвучку…' : 'Ответ готов');
        }
        if (event.type === 'history') {
          if (keepLocal.current) return;
          historyStamp.current += 1;
          const incoming = (event.messages ?? []).map((entry: Entry) => ({ id: nextId(), role: entry.role, content: entry.content, kind: 'text' as const }));
          setMessages(incoming);
        }
        if (event.type === 'devices') setDevices(event.devices ?? []);
        if (event.type === 'voice.clip' && event.audio) {
          try {
            const url = URL.createObjectURL(wavBlob(event.audio));
            urls.current.push(url);
            setMessages(list => [...list.slice(-99), { id: nextId(), role: 'user', content: '', kind: 'voice', audioUrl: url, durationMs: event.duration_ms, pending: true }]);
          } catch { setError('Не удалось показать запись'); }
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
        if (event.type === 'recording') { setRecording(true); setThinking(false); }
        if (event.type === 'transcribing') { setRecording(false); setThinking(true); setLiveState(state => state === 'off' ? state : 'thinking'); }
        if (event.type === 'speaking') { setThinking(false); setLiveState(state => state === 'off' ? state : 'speaking'); postNotice('Нейра говорит. Стоп прервёт озвучку.'); }
        if (event.type === 'live.started') { setLiveOpen(true); setMuted(false); setLiveState('idle'); }
        if (event.type === 'live.stopped') { setLiveState('off'); setMicLevel(0); if (!muteHold.current) { setLiveOpen(false); setMuted(false); } }
        if (event.type === 'live.idle') setLiveState(state => state === 'off' ? state : 'idle');
        if (event.type === 'wake') setLiveState('armed');
        if (event.type === 'listening') { tokenBuffer.current = ''; setPartial(''); setLiveState('listening'); }
        if (event.type === 'mic.level') setMicLevel(meterLevel(event.db ?? -100));
        if (event.type === 'status' && event.state === 'thinking') setLiveState(state => state === 'off' ? state : 'thinking');
        if (event.type === 'status' && event.state === 'slow') postNotice('Провайдер отвечает медленно, я ещё думаю…');
        if (event.type === 'status' && event.state === 'truncated') postNotice('Ответ длинный: озвучено только начало, полный текст в чате.', true);
        if (event.type === 'voice.conversion') { const text = conversionNotice(event.status, event.code); if (text) postNotice(text, true); }
        if (event.type === 'disconnected') { muteHold.current = false; setLiveOpen(false); setMuted(false); setLiveState('off'); setConnected(false); setThinking(false); setRecording(false); setActive(false); setHostCall(undefined); tokenBuffer.current = ''; setPartial(''); postNotice('Соединение закрыто. Подключитесь повторно.', true); }
        if (event.type === 'error') { setError(`Сервер: ${event.code ?? 'ошибка'}. Повторите попытку.`); setThinking(false); tokenBuffer.current = ''; setPartial(''); setLiveState(state => state === 'thinking' ? 'idle' : state); }
        if (event.type === 'cancelled') {
          setThinking(false); setRecording(false); setActive(false); setHostCall(undefined); tokenBuffer.current = ''; setPartial(''); postNotice('Остановлено');
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
    return () => { for (const listener of listeners) void listener.then(unlisten => unlisten()); };
  }, []);

  useEffect(() => {
    if (!hostCall) return;
    const timeout = window.setTimeout(() => setHostCall(undefined), Math.max(0, hostCall.deadline_ms - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [hostCall]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setTimeout(() => {
      void invoke('record_stop').then(() => { setRecording(false); setThinking(true); postNotice('Запись завершена: лимит 30 секунд.', true); }).catch(reason => { setRecording(false); setError(formatError(reason)); });
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [recording]);

  const save = async (next: Settings) => { await invoke('save_settings', { settings: next }); setSettings(next); };
  const patchProfile = (patch: Partial<Profile>) => { if (settings && profile) setSettings({ ...settings, profiles: settings.profiles.map(item => item.id === profileId ? { ...item, ...patch } : item) }); };
  const request = async <T,>(path: string, method = 'GET') => unwrapApi<T>(await invoke<unknown>('api', { profileId, path, method }));
  const rememberLive = (runId: unknown) => { if (typeof runId === 'number') liveRun.current = runId; };
  const stop = () => run(async () => { await invoke('stop'); setHostCall(undefined); setActive(false); setThinking(false); setRecording(false); muteHold.current = false; setLiveOpen(false); setMuted(false); setLiveState('off'); });
  const saveVoice = (patch: Partial<VoiceSettings>) => run(async () => { if (!settings) return; await save({ ...settings, voice: { ...voice, ...patch } }); setLiveState('off'); });
  const draftVoice = (patch: Partial<VoiceSettings>) => { if (settings) setSettings({ ...settings, voice: { ...voice, ...patch } }); };
  const refreshVoice = () => run(async () => { setVoiceStatus(await invoke<VoiceStatus>('voice_status')); });
  const startLive = () => run(async () => { muteHold.current = false; rememberLive(await invoke<number>('live_start')); setLiveOpen(true); setMuted(false); setLiveState('idle'); });
  const toggleMute = () => run(async () => {
    if (muted) { muteHold.current = false; rememberLive(await invoke<number>('live_start')); setMuted(false); }
    else { muteHold.current = true; await invoke('live_stop'); setMuted(true); setMicLevel(0); postNotice('Микрофон на паузе'); }
  });
  const endLive = () => run(async () => { muteHold.current = false; await invoke('live_stop'); await invoke('stop'); setLiveOpen(false); setMuted(false); setMicLevel(0); setThinking(false); setLiveState('off'); postNotice('Разговор завершён'); });
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
    const [health, schema] = await Promise.all([request<unknown>('/v1/health'), invoke<{ info: { version: string } }>('api', { profileId, path: '/openapi.json', method: 'GET' })]);
    if (!schema.info.version.startsWith('1.')) throw 'Несовместимая версия API. Требуется 1.x.';
    setStatus(health); postNotice(`Сервер доступен · API ${schema.info.version}`);
  });
  const connect = () => run(async () => {
    if (!settings || !profile || !validServerUrl(profile.url)) throw 'Сначала настройте сервер.';
    await save(settingsForServer(settings));
    if (token) { await invoke('store_token', { profileId, token }); setToken(''); }
    const active = threads.find(item => item.id === activeId);
    const preserve = messages.length > 0 || (active?.messages.length ?? 0) > 0;
    keepLocal.current = preserve;
    await invoke('connect', { profileId }); setConnected(true);
    if (!preserve) setMessages([]);
    if (!preserve) await invoke('bridge_message', { kind: 'history' });
    await invoke('bridge_message', { kind: 'devices' });
  });
  const disconnect = () => run(async () => { keepLocal.current = false; await invoke('disconnect'); setConnected(false); setDevices([]); setTarget(''); });
  const sendContent = (value: string) => run(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const result = await invoke<{ handled: boolean; command?: string }>('chat', { text: trimmed, targetDeviceId: target || null });
    setMessages(list => {
      const next = [...list.slice(-99), { id: nextId(), role: 'user' as const, content: trimmed, kind: 'text' as const }];
      return result?.handled ? [...next, { id: nextId(), role: 'assistant', content: `Команда «${result.command}» запущена на этом ПК.`, kind: 'text' }] : next;
    });
    if (!result?.handled) setThinking(true);
    setText('');
  });
  const decideDraft = (accepted: boolean, item: DraftEvent) => run(async () => { setDraft(undefined); if (accepted) { await invoke('draft_confirm', { draftId: item.draft_id }); postNotice('Команда сохранена на этом ПК', true); } else await invoke('draft_reject', { draftId: item.draft_id }); });
  const beginRecording = () => run(async () => { await invoke('record_start'); setRecording(true); });
  const finishRecording = () => run(async () => { await invoke('record_stop'); setRecording(false); setThinking(true); postNotice('Распознаю речь…'); });
  const cancelRecording = () => run(async () => { await invoke('record_cancel'); setRecording(false); postNotice('Запись отменена'); });
  const copyText = (value: string) => { void navigator.clipboard.writeText(value).then(() => { postNotice('Скопировано'); }).catch(() => setError('Не удалось скопировать')); };
  const speak = (value: string) => run(async () => {
    const spoken = [...value.trim()].slice(0, 300).join('');
    if (!spoken) return;
    await invoke('speak_text', { text: spoken });
    postNotice(spoken.length < value.trim().length ? 'Озвучено начало ответа: голос принимает до 300 символов.' : 'Озвучиваю ответ', spoken.length < value.trim().length);
  });
  const approve = (allow: boolean) => run(async () => { if (hostCall) { const id = hostCall.call_id; setHostCall(undefined); await invoke('approve', { callId: id, allow }); } });
  const setTheme = (nextTheme: string) => run(async () => { if (!settings) return; await save({ ...settings, theme: nextTheme }); });
  const blockSwitch = () => {
    if (thinking || partial || recording || liveOpen || active || hostCall || draft) throw 'Сначала остановите текущий ход кнопкой «Стоп»';
  };
  const switchSession = async (sessionId: string, preserveMessages: boolean) => {
    if (!settings || !profile || profile.session_id === sessionId) return;
    const previousId = profile.session_id;
    const withSession = (id: string): Settings => ({ ...settings, profiles: settings.profiles.map(item => item.id === profile.id ? { ...item, session_id: id } : item) });
    await save(withSession(sessionId));
    if (!connected) return;
    try {
      await invoke('disconnect');
      setConnected(false);
      await invoke('connect', { profileId: profile.id });
      setConnected(true);
      await invoke('bridge_message', { kind: 'devices' });
      keepLocal.current = preserveMessages;
      if (!preserveMessages) await invoke('bridge_message', { kind: 'history' });
    } catch (reason) {
      try {
        keepLocal.current = true;
        await save(withSession(previousId));
        await invoke('disconnect');
        await invoke('connect', { profileId: profile.id });
        setConnected(true);
        await invoke('bridge_message', { kind: 'devices' });
      } catch { setConnected(false); }
      throw reason;
    }
  };
  const newChat = () => run(async () => {
    blockSwitch();
    const sessionId = crypto.randomUUID();
    const fresh: ChatThread = { id: nextId(), title: 'Новый чат', sessionId, updated: Date.now(), messages: [] };
    const saved = threads.map(item => item.id === activeId ? { ...item, messages: messages.map(stripAudio), title: threadTitle(messages), updated: Date.now() } : item);
    await switchSession(sessionId, true);
    setThreads([fresh, ...saved].slice(0, 30));
    setActiveId(fresh.id);
    setMessages([]);
    setPartial(''); tokenBuffer.current = ''; setHistoryOpen(false); setMenuOpen(false);
  });
  const openThread = (id: string) => run(async () => {
    blockSwitch();
    const switched = switchThread(threads, activeId, messages, id);
    if (!switched) { setHistoryOpen(false); return; }
    const target = switched.threads.find(item => item.id === switched.activeId);
    const sessionId = ensureSessionId(target?.sessionId);
    const nextThreads = target && target.sessionId !== sessionId ? switched.threads.map(item => item.id === target.id ? { ...item, sessionId } : item) : switched.threads;
    const hadMessages = !!(target && target.messages.length > 0);
    const beforeHistory = historyStamp.current;
    await switchSession(sessionId, hadMessages);
    setThreads(nextThreads);
    setActiveId(switched.activeId);
    if (hadMessages) setMessages(switched.messages);
    else if (historyStamp.current === beforeHistory) setMessages([]);
    setPartial(''); tokenBuffer.current = ''; setHistoryOpen(false);
  });
  const addProfile = (created: Profile) => {
    if (!settings) return;
    const active = threads.find(item => item.id === activeId);
    const sessionId = firstServerSession(settings.profiles.length > 0, created.session_id, active?.sessionId);
    if (settings.profiles.length === 0 && active && active.sessionId !== sessionId) setThreads(list => list.map(item => item.id === active.id ? { ...item, sessionId } : item));
    const next = { ...settings, active_profile: created.id, profiles: [...settings.profiles, { ...created, session_id: sessionId }] };
    setSettings(next);
    setProfileId(created.id);
    void save(next).catch(reason => setError(formatError(reason)));
  };
  const chooseProfile = (id: string) => {
    setProfileId(id);
    setToken('');
    setStatus(undefined);
    if (!settings) return;
    const active = threads.find(item => item.id === activeId);
    const profiles = active && isUuid(active.sessionId) ? bindProfileSession(settings.profiles, id, active.sessionId) : settings.profiles;
    const next = { ...settings, profiles, active_profile: id };
    setSettings(next);
    void save(next).catch(reason => setError(formatError(reason)));
  };
  const refreshStatus = () => run(async () => { const out = await request<unknown>('/v1/health'); setStatus(out); });
  const refreshPlugins = () => run(async () => { const out = await request<{ plugins?: Plugin[] }>('/v1/plugins'); setPlugins(Array.isArray(out?.plugins) ? out.plugins : []); });
  const restartCore = () => { if (window.confirm('Перезапустить ядро сервера? Активные ходы прервутся.')) void run(async () => { await request('/v1/system/restart', 'POST'); postNotice('Запрошен мягкий рестарт', true); }); };
  const togglePlugin = (plugin: Plugin) => { if (window.confirm('Изменить состояние модуля? Для resident ядро будет перезапущено.')) void run(async () => { await invoke('set_module', { profileId, moduleId: plugin.id, enabled: !plugin.enabled }); setPlugins(list => list.map(item => item.id === plugin.id ? { ...item, enabled: !item.enabled } : item)); }); };
  const refreshDevices = () => run(async () => { await invoke('bridge_message', { kind: 'devices' }); });
  const disconnectDevice = () => { if (window.confirm('Отключить выбранный ПК? Действия будут отменены, повторное подключение выполняется на том ПК вручную.')) void run(async () => { await invoke('disconnect_device', { deviceId: target }); setTarget(''); }); };

  return {
    settings, setSettings, root, shortcuts, pcAvailable, profileId, profile, connected, busy, error, notice, noticeSticky, appVersion, platform, messages, partial, lastTrace, text, setText, thinking, recording, active, hostCall, devices, target, setTarget, status, plugins, token, setToken, recoveries, draft, runLine, commandRunning, backends, liveState, micLevel, voiceStatus, voice, liveOpen, muted, threads, activeId, sheet, menuOpen, historyOpen, theme: themeId(settings?.theme),
    run, notify, dismissNotice, save, patchProfile, openSheet, closeSheet, closeMenu, setMenuOpen, setHistoryOpen, stop, saveVoice, draftVoice, refreshVoice, startLive, toggleMute, endLive, check, connect, disconnect, sendContent, decideDraft, beginRecording, finishRecording, cancelRecording, copyText, speak, approve, setTheme, newChat, openThread, addProfile, chooseProfile, refreshStatus, refreshPlugins, refreshDevices, restartCore, togglePlugin, disconnectDevice, setSheet,
  };
}
