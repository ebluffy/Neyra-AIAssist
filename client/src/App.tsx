import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type DraftEvent, type RunEvent, describeRun } from './commands';
import { CommandsScreen } from './screens/CommandsScreen';
import { DraftDialog } from './screens/DraftDialog';
import { PermissionsScreen } from './screens/PermissionsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { type Device, type Entry, type HostCall, type LiveState, type Plugin, type Profile, type Recovery, type ServerEvent, type Settings, type VoiceSettings, type VoiceStatus, conversionNotice, defaultVoice, formatError, liveLabel, meterLevel, newProfile, tabs, validServerUrl } from './types';

export function App() {
  const [settings, setSettings] = useState<Settings>();
  const [root, setRoot] = useState('');
  const [shortcuts, setShortcuts] = useState(false);
  const [pcAvailable, setPcAvailable] = useState(false);
  const [tab, setTab] = useState<typeof tabs[number]>('Сервер');
  const [profileId, setProfileId] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<Entry[]>([]);
  const [partial, setPartial] = useState('');
  const [lastTrace, setLastTrace] = useState<unknown>();
  const messagePanel = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
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
  const [liveState, setLiveState] = useState<LiveState>('off');
  const [micLevel, setMicLevel] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>();
  const modal = useRef<HTMLDialogElement>(null);
  const profile = settings?.profiles.find(p => p.id === profileId);
  const voice: VoiceSettings = settings?.voice ?? defaultVoice;
  const live = liveState !== 'off';
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(formatError(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    void invoke<{ settings: Settings; data_root: string; global_shortcuts: boolean; pc_access_available: boolean; recoveries?: Recovery[] }>('load_settings').then(data => {
      setSettings(data.settings); setRoot(data.data_root); setShortcuts(data.global_shortcuts); setPcAvailable(data.pc_access_available); setProfileId(data.settings.profiles[0]?.id ?? ''); setRecoveries(data.recoveries ?? []);
    }).catch(e => setError(formatError(e)));
    const timer = window.setInterval(() => setPartial(tokenBuffer.current), 60);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const listeners = [
      listen<ServerEvent>('desktop-event', ({ payload: e }) => {
        if (e.type === 'hello') setConnected(true);
        if (e.type === 'token') tokenBuffer.current += e.text ?? '';
        if (e.type === 'done') {
          setLastTrace(e.model_trace);
          setHistory(h => [...h.slice(-99), { role: 'assistant', content: e.text ?? '' }]);
          tokenBuffer.current = ''; setPartial(''); setThinking(e.source === 'voice'); setNotice(e.source === 'voice' ? 'Готовлю озвучку…' : 'Ответ готов');
        }
        if (e.type === 'history') setHistory(e.messages ?? []);
        if (e.type === 'devices') setDevices(e.devices ?? []);
        if (e.type === 'transcript.final') { setHistory(h => [...h.slice(-99), { role: 'user', content: e.text ?? '' }]); setNotice('Речь распознана'); }
        if (e.type === 'pc_access') setPcAvailable(e.available ?? false);
        if (e.type === 'audio.finished') { setNotice('Озвучка завершена'); setLiveState(s => s === 'off' ? s : 'idle'); }
        if (e.type === 'recording') { setRecording(true); setThinking(false); }
        if (e.type === 'transcribing') { setRecording(false); setThinking(true); setLiveState(s => s === 'off' ? s : 'thinking'); }
        if (e.type === 'speaking') { setThinking(false); setLiveState(s => s === 'off' ? s : 'speaking'); setNotice('Нейра говорит. Stop прервёт озвучку.'); }
        if (e.type === 'live.started') { setLiveState('idle'); setNotice(e.mode === 'wake' ? 'Скажите «Нейра» и команду. До слова «Нейра» звук не покидает ПК.' : 'Микрофон включён: говорите, Нейра ответит после паузы.'); }
        if (e.type === 'live.stopped') { setLiveState('off'); setMicLevel(0); }
        if (e.type === 'live.idle') setLiveState(s => s === 'off' ? s : 'idle');
        if (e.type === 'wake') setLiveState('armed');
        if (e.type === 'listening') setLiveState('listening');
        if (e.type === 'mic.level') setMicLevel(meterLevel(e.db ?? -100));
        if (e.type === 'status' && e.state === 'thinking') setLiveState(s => s === 'off' ? s : 'thinking');
        if (e.type === 'status' && e.state === 'slow') setNotice('Провайдер отвечает медленно, я ещё думаю…');
        if (e.type === 'status' && e.state === 'truncated') setNotice('Ответ длинный: озвучено только начало, полный текст в чате.');
        if (e.type === 'voice.conversion') setNotice(conversionNotice(e.status, e.code));
        if (e.type === 'disconnected') { setLiveState('off'); setConnected(false); setThinking(false); setRecording(false); setActive(false); setHostCall(undefined); setNotice('Соединение закрыто. Подключитесь повторно.'); }
        if (e.type === 'error') { setError(`Сервер: ${e.code ?? 'ошибка'}. Повторите попытку.`); setThinking(false); }
        if (e.type === 'cancelled') { setThinking(false); setRecording(false); setActive(false); setHostCall(undefined); tokenBuffer.current = ''; setPartial(''); setNotice('Остановлено'); }
      }),
      listen<HostCall>('host-confirm', ({ payload }) => setHostCall(payload)),
      listen<{ call_id?: string }>('host-confirm-closed', ({ payload }) => {
        setHostCall(current => (current && (!payload.call_id || current.call_id === payload.call_id) ? undefined : current));
      }),
      listen<{ active: boolean }>('host-activity', ({ payload }) => setActive(payload.active)),
      listen<RunEvent>('command-run', ({ payload }) => {
        setRunLine(describeRun(payload)); setCommandRunning(payload.state === 'started' || payload.state === 'step'); setThinking(false);
        if (payload.state === 'failed') setError(describeRun(payload)); else setNotice(describeRun(payload));
      }),
      listen<DraftEvent>('command-draft', ({ payload }) => setDraft(payload)),
      listen<{ reason: string }>('command-draft-invalid', ({ payload }) => setError(`Черновик команды отклонён: ${payload.reason}`)),
    ];
    return () => { for (const listener of listeners) void listener.then(unlisten => unlisten()); };
  }, []);
  useEffect(() => { if (hostCall) modal.current?.showModal(); else modal.current?.close(); }, [hostCall]);
  useEffect(() => {
    if (!hostCall) return;
    const timeout = window.setTimeout(() => setHostCall(undefined), Math.max(0, hostCall.deadline_ms - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [hostCall]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setTimeout(() => {
      void invoke('record_stop').then(() => { setRecording(false); setThinking(true); setNotice('Запись завершена: лимит 30 секунд.'); }).catch(e => { setRecording(false); setError(formatError(e)); });
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [recording]);
  useEffect(() => {
    const panel = messagePanel.current;
    if (panel && followMessages.current) panel.scrollTop = panel.scrollHeight;
  }, [history, partial]);
  const save = async (next: Settings) => { await invoke('save_settings', { settings: next }); setSettings(next); };
  const patchProfile = (patch: Partial<Profile>) => { if (settings && profile) setSettings({ ...settings, profiles: settings.profiles.map(p => p.id === profileId ? { ...p, ...patch } : p) }); };
  const request = async (path: string, method = 'GET') => invoke<{ data: unknown }>('api', { profileId, path, method });
  const stop = () => run(async () => { await invoke('stop'); setHostCall(undefined); setActive(false); setThinking(false); setRecording(false); setLiveState('off'); });
  const saveVoice = (patch: Partial<VoiceSettings>) => run(async () => { if (!settings) return; await save({ ...settings, voice: { ...voice, ...patch } }); setLiveState('off'); });
  const refreshVoice = () => run(async () => { setVoiceStatus(await invoke<VoiceStatus>('voice_status')); });
  const startLive = () => run(async () => { await invoke('live_start'); setLiveState('idle'); });
  const pauseLive = () => run(async () => { await invoke('live_stop'); setLiveState('off'); setMicLevel(0); setNotice('Микрофон на паузе'); });
  const endLive = () => run(async () => { await invoke('live_stop'); await invoke('stop'); setLiveState('off'); setMicLevel(0); setThinking(false); setNotice('Разговор завершён'); });
  const check = () => run(async () => {
    if (!settings || !profile || !validServerUrl(profile.url)) throw 'Укажите HTTPS-адрес или HTTP localhost.';
    await save(settings);
    if (token) { await invoke('store_token', { profileId, token }); setToken(''); }
    const [health, schema] = await Promise.all([request('/v1/health'), invoke<{ info: { version: string } }>('api', { profileId, path: '/openapi.json', method: 'GET' })]);
    if (!schema.info.version.startsWith('1.')) throw 'Несовместимая версия API. Требуется 1.x.';
    setStatus(health.data); setNotice(`Сервер доступен · API ${schema.info.version}`);
  });
  const connect = () => run(async () => {
    if (!settings || !profile || !validServerUrl(profile.url)) throw 'Сначала настройте сервер.';
    await save(settings);
    if (token) { await invoke('store_token', { profileId, token }); setToken(''); }
    await invoke('connect', { profileId }); setConnected(true); setHistory([]); setTab('Чат');
    await invoke('bridge_message', { kind: 'history' }); await invoke('bridge_message', { kind: 'devices' });
  });
  const updateDevices = () => run(async () => { await invoke('bridge_message', { kind: 'devices' }); });
  const sendText = () => run(async () => {
    const result = await invoke<{ handled: boolean; command?: string }>('chat', { text, targetDeviceId: target || null });
    setHistory(h => [...h.slice(-99), { role: 'user', content: text }]);
    if (result?.handled) setHistory(h => [...h.slice(-99), { role: 'assistant', content: `Команда «${result.command}» запущена на этом ПК.` }]); else setThinking(true);
    setText('');
  });
  const notify = useCallback((message: string) => { setNotice(message); setError(''); }, []);
  const decideDraft = (accepted: boolean, d: DraftEvent) => run(async () => { setDraft(undefined); if (accepted) { await invoke('draft_confirm', { draftId: d.draft_id }); setNotice('Команда сохранена на этом ПК'); } else await invoke('draft_reject', { draftId: d.draft_id }); });
  const record = () => run(async () => {
    if (recording) { await invoke('record_stop'); setRecording(false); setThinking(true); setNotice('Распознаю речь…'); }
    else { await invoke('record_start'); setRecording(true); setNotice('Микрофон включён. До 30 секунд; нажмите ещё раз для отправки.'); }
  });
  const approve = (allow: boolean) => run(async () => { if (hostCall) { const id = hostCall.call_id; setHostCall(undefined); await invoke('approve', { callId: id, allow }); } });
  return <div className="shell" data-theme={settings?.theme ?? 'dark'}>
    <header><strong>Neyra</strong><span className="connection">{connected ? 'Подключено' : 'Нет подключения'}</span><span className="activity" role="status">{active ? 'Нейра управляет ПК' : recording || live ? '● Микрофон включён' : thinking ? 'Думаю…' : ''}</span><button className="stop" onClick={stop}>Stop</button></header>
    <nav aria-label="Разделы">{tabs.map(name => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>{name}</button>)}</nav>
    <main aria-busy={busy}>
      {error && <div className="error" id="form-error" role="alert">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      {!settings && <section><h1>Запуск Neyra</h1><p>Загружаю локальные настройки…</p><p>Для работы нужен установленный десктоп-клиент.</p></section>}
      {tab === 'Сервер' && settings && <section><h1>Сервер</h1><p>Профили хранятся на этом ПК. Токены — в системном хранилище секретов.</p>
        <label>Профиль<select value={profileId} disabled={busy || connected} onChange={e => { setProfileId(e.target.value); setToken(''); setStatus(undefined); }}><option value="">Выберите сервер</option>{settings.profiles.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
        <button disabled={busy || connected || settings.profiles.length >= 12} onClick={() => { const p = newProfile(); setSettings({ ...settings, profiles: [...settings.profiles, p] }); setProfileId(p.id); }}>Добавить профиль</button>
        {profile && <><label>Название<input value={profile.name} maxLength={80} disabled={connected} onChange={e => patchProfile({ name: e.target.value })}/></label><label>Адрес сервера<input type="url" aria-describedby={error ? 'form-error' : undefined} aria-invalid={!validServerUrl(profile.url)} value={profile.url} disabled={connected} onChange={e => patchProfile({ url: e.target.value })}/></label><label>Токен<input type="password" value={token} autoComplete="off" disabled={connected} onChange={e => setToken(e.target.value)} placeholder="Оставьте пустым, чтобы использовать сохранённый"/></label><div className="actions"><button disabled={busy || connected} onClick={check}>Проверить подключение</button><button disabled={busy || connected} onClick={connect}>Подключить</button><button disabled={busy || !connected} onClick={() => run(async () => { await invoke('disconnect'); setConnected(false); setDevices([]); setTarget(''); })}>Отключить</button></div></>}
            </section>}
      {tab === 'Чат' && <section className="chat"><h1>Чат</h1><div ref={messagePanel} onScroll={e => { const el = e.currentTarget; followMessages.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} className="messages" aria-label="История чата">{history.length === 0 && <p>Здесь появится разговор с Нейрой.</p>}{history.map((entry, i) => <article key={i}><strong>{entry.role === 'user' ? 'Вы' : 'Нейра'}</strong><p>{entry.content}</p></article>)}{partial && <article><strong>Нейра</strong><p>{partial}</p></article>}</div>
        {lastTrace !== undefined && <details><summary>Модели последнего ответа</summary><pre>{JSON.stringify(lastTrace, null, 2)}</pre></details>}<label>ПК для действий<select value={target} disabled={!connected} onChange={e => setTarget(e.target.value)}><option value="">Этот ПК</option>{devices.map(d => <option key={d.device_id} value={d.device_id}>{d.name} · {d.device_id.slice(0, 8)}</option>)}</select></label><button onClick={updateDevices} disabled={!connected || busy}>Обновить устройства</button><button disabled={!connected || busy || !target} onClick={() => { if (window.confirm('Отключить выбранный ПК? Действия будут отменены, повторное подключение выполняется на том ПК вручную.')) void run(async () => { await invoke('disconnect_device', { deviceId: target }); setTarget(''); }); }}>Отключить выбранный ПК</button>
        <form onSubmit={e => { e.preventDefault(); void sendText(); }}><label>Сообщение<textarea value={text} onChange={e => setText(e.target.value)} maxLength={6000} disabled={!connected}/></label><div className="actions"><button disabled={busy || !connected || thinking || !text.trim()}>Отправить</button><button type="button" aria-pressed={recording} onClick={record} disabled={busy || !connected || live || (thinking && !recording)}>{recording ? 'Завершить и отправить' : 'Записать голос'}</button></div></form><p>{shortcuts ? 'Push-to-talk: удерживайте Ctrl+Alt+Space; Stop: Ctrl+Alt+Escape. Также доступны кнопки.' : 'Глобальные хоткеи недоступны: используйте кнопки записи и Stop.'} Аудио не сохраняется.</p>
      </section>}
      {tab === 'Голос' && settings && <section className="voice"><h1>Голос</h1>
        <p>STT и TTS работают на сервере. На этом ПК только микрофон, воспроизведение и детектор слова «Нейра». Аудио не сохраняется.</p>
        <div className="live" role="group" aria-label="Разговор голосом"><p className="live-state" role="status">{liveLabel(liveState, voice.mode)}</p><meter aria-label="Уровень микрофона" min={0} max={1} value={live ? micLevel : 0}/>
          <div className="actions">{live ? <><button disabled={busy} onClick={pauseLive}>Пауза микрофона</button><button disabled={busy} onClick={endLive}>Завершить разговор</button></> : <button disabled={busy || !connected || voice.mode === 'ptt' || recording} onClick={startLive}>Начать разговор</button>}</div>
          {voice.mode === 'ptt' && <p>Режим push-to-talk: используйте кнопку «Записать голос» в чате или Ctrl+Alt+Space.</p>}
          {!connected && <p>Подключитесь к серверу, чтобы говорить с Нейрой.</p>}</div>
        <h2>Режим</h2>
        <label>Как начинать разговор<select value={voice.mode} disabled={busy} onChange={e => void saveVoice({ mode: e.target.value as VoiceSettings['mode'] })}><option value="ptt">Push-to-talk: кнопка или хоткей</option><option value="wake">Слово «Нейра» и команда</option><option value="always">Слушать всегда</option></select></label>
        <label>Чувствительность к речи: {Math.round(voice.vad_sensitivity * 100)}%<input type="range" min={0} max={1} step={0.05} value={voice.vad_sensitivity} disabled={busy} onChange={e => setSettings({ ...settings, voice: { ...voice, vad_sensitivity: Number(e.target.value) } })} onPointerUp={() => void saveVoice({})} onKeyUp={() => void saveVoice({})}/></label>
        <label>Пауза, после которой фраза закончена<select value={voice.end_silence_ms} disabled={busy} onChange={e => void saveVoice({ end_silence_ms: Number(e.target.value) })}><option value={500}>0,5 с</option><option value={700}>0,7 с</option><option value={1000}>1 с</option><option value={1500}>1,5 с</option></select></label>
        <label>Перебивать Нейру голосом<select value={voice.barge_in} disabled={busy} onChange={e => void saveVoice({ barge_in: e.target.value as VoiceSettings['barge_in'] })}><option value="off">Нет: микрофон молчит, пока Нейра говорит</option><option value="headphones">Да, я в наушниках</option></select></label>
        <p>{voice.barge_in === 'off' ? 'Эхоподавления нет: пока Нейра говорит, микрофон выключен, чтобы она не слышала сама себя. Перебить можно кнопкой Stop или Ctrl+Alt+Escape.' : 'Работает только в наушниках. Через колонки Нейра услышит свой голос и перебьёт сама себя: эхоподавления нет.'}</p>
        <h2>Слово «Нейра»</h2>
        <label>Порог срабатывания: {Math.round(voice.wake_threshold * 100)}%<input type="range" min={0.05} max={0.99} step={0.01} value={voice.wake_threshold} disabled={busy} onChange={e => setSettings({ ...settings, voice: { ...voice, wake_threshold: Number(e.target.value) } })} onPointerUp={() => void saveVoice({})} onKeyUp={() => void saveVoice({})}/></label>
        <button disabled={busy} onClick={refreshVoice}>Проверить модель</button>
        {voiceStatus && (voiceStatus.wake.ready ? <p role="status">Модель готова: {voiceStatus.wake.model} · {voiceStatus.wake.license}</p> : <p role="status">Модель не готова: {voiceStatus.wake.message}</p>)}
        <p>Модель лежит локально в папке <span className="path">{voiceStatus?.wake.dir ?? `${root}/wakeword`}</span>: melspectrogram.onnx, embedding_model.onnx, модель «Нейра» и wakeword.json. Английские модели openWakeWord не подходят.</p>
      </section>}
      {tab === 'Статус' && <section><h1>Статус сервера</h1><button disabled={busy || !profileId} onClick={() => run(async () => { const out = await request('/v1/health'); setStatus(out.data); })}>Обновить статус</button>{status ? <pre>{JSON.stringify(status, null, 2)}</pre> : <p>Выберите сервер и проверьте подключение.</p>}</section>}
      {tab === 'Модули' && <section><h1>Модули</h1><div className="actions"><button disabled={busy || !profileId} onClick={() => run(async () => { const out = await request('/v1/plugins'); setPlugins((out.data as { plugins: Plugin[] }).plugins); })}>Обновить модули</button><button disabled={busy || !profileId} onClick={() => { if (window.confirm('Перезапустить ядро сервера? Активные ходы прервутся.')) void run(async () => { await request('/v1/system/restart', 'POST'); setNotice('Запрошен мягкий рестарт'); }); }}>Мягкий рестарт</button></div>{plugins.length === 0 && <p>Загрузите список модулей.</p>}{plugins.map(p => <article key={p.id}><h2>{p.name ?? p.id}</h2><p>{p.lifecycle ?? 'Модуль'} · {p.enabled ? 'Включён' : 'Выключен'}</p><button disabled={busy} onClick={() => { if (window.confirm('Изменить состояние модуля? Для resident ядро будет перезапущено.')) void run(async () => { await invoke('set_module', { profileId, moduleId: p.id, enabled: !p.enabled }); setPlugins(list => list.map(x => x.id === p.id ? { ...x, enabled: !x.enabled } : x)); }); }}>{p.enabled ? 'Выключить' : 'Включить'}</button></article>)}</section>}
      {tab === 'Команды' && <CommandsScreen busy={busy} run={run} notify={notify} runLine={runLine} running={commandRunning}/>}
      {tab === 'Доступ к ПК' && settings && <PermissionsScreen settings={settings} setSettings={setSettings} save={save} pcAvailable={pcAvailable} busy={busy} run={run} notify={notify}/>}
      {tab === 'Настройки' && settings && <SettingsScreen settings={settings} setSettings={setSettings} save={save} root={root} recoveries={recoveries} connected={connected} busy={busy} run={run} notify={notify} applyImported={setSettings}/>}
    </main>
    <DraftDialog draft={draft} busy={busy} onSave={d => void decideDraft(true, d)} onReject={d => void decideDraft(false, d)}/>
    <dialog aria-labelledby="confirm-title" ref={modal} onCancel={e => { e.preventDefault(); void approve(false); }}><h2 id="confirm-title">{hostCall?.tool === 'command.run' ? 'Запустить быструю команду?' : 'Разрешить действие на этом ПК?'}</h2><p>{hostCall?.tool === 'command.run' ? String(hostCall.arguments.name ?? '') : hostCall?.tool}</p><pre>{JSON.stringify(hostCall?.arguments, null, 2)}</pre><p>Подтверждение действует только для этого вызова, до 30 секунд.</p><div className="actions"><button autoFocus onClick={() => void approve(false)}>Отклонить</button><button onClick={() => void approve(true)}>Разрешить один раз</button></div></dialog>
  </div>;
}
