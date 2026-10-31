import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type AuditRow, type Device, type Entry, type HostCall, type Plugin, type Profile, type ServerEvent, type Settings, formatError, newProfile, tabs, validServerUrl } from './types';

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
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [token, setToken] = useState('');
  const [applications, setApplications] = useState<string[]>([]);
  const [appFilter, setAppFilter] = useState('');
  const modal = useRef<HTMLDialogElement>(null);
  const profile = settings?.profiles.find(p => p.id === profileId);
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError(formatError(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    void invoke<{ settings: Settings; data_root: string; global_shortcuts: boolean; pc_access_available: boolean }>('load_settings').then(data => {
      setSettings(data.settings); setRoot(data.data_root); setShortcuts(data.global_shortcuts); setPcAvailable(data.pc_access_available); setProfileId(data.settings.profiles[0]?.id ?? '');
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
        if (e.type === 'audio.finished') setNotice('Озвучка завершена');
        if (e.type === 'recording') { setRecording(true); setThinking(false); }
        if (e.type === 'transcribing') { setRecording(false); setThinking(true); }
        if (e.type === 'speaking') { setThinking(false); setNotice('Нейра говорит. Stop прервёт озвучку.'); }
        if (e.type === 'disconnected') { setConnected(false); setThinking(false); setRecording(false); setActive(false); setHostCall(undefined); setNotice('Соединение закрыто. Подключитесь повторно.'); }
        if (e.type === 'error') { setError(`Сервер: ${e.code ?? 'ошибка'}. Повторите попытку.`); setThinking(false); }
        if (e.type === 'cancelled') { setThinking(false); setRecording(false); setActive(false); setHostCall(undefined); tokenBuffer.current = ''; setPartial(''); setNotice('Остановлено'); }
      }),
      listen<HostCall>('host-confirm', ({ payload }) => setHostCall(payload)),
      listen<{ call_id?: string }>('host-confirm-closed', ({ payload }) => {
        setHostCall(current => (current && (!payload.call_id || current.call_id === payload.call_id) ? undefined : current));
      }),
      listen<{ active: boolean }>('host-activity', ({ payload }) => setActive(payload.active)),
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
  const stop = () => run(async () => { await invoke('stop'); setHostCall(undefined); setActive(false); setThinking(false); setRecording(false); });
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
  const sendText = () => run(async () => { await invoke('chat', { text, targetDeviceId: target || null }); setHistory(h => [...h.slice(-99), { role: 'user', content: text }]); setText(''); setThinking(true); });
  const record = () => run(async () => {
    if (recording) { await invoke('record_stop'); setRecording(false); setThinking(true); setNotice('Распознаю речь…'); }
    else { await invoke('record_start'); setRecording(true); setNotice('Микрофон включён. До 30 секунд; нажмите ещё раз для отправки.'); }
  });
  const approve = (allow: boolean) => run(async () => { if (hostCall) { const id = hostCall.call_id; setHostCall(undefined); await invoke('approve', { callId: id, allow }); } });
  return <div className="shell" data-theme={settings?.theme ?? 'dark'}>
    <header><strong>Neyra</strong><span className="connection">{connected ? 'Подключено' : 'Нет подключения'}</span><span className="activity" role="status">{active ? 'Нейра управляет ПК' : recording ? '● Микрофон включён' : thinking ? 'Думаю…' : ''}</span><button className="stop" onClick={stop}>Stop</button></header>
    <nav aria-label="Разделы">{tabs.map(name => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>{name}</button>)}</nav>
    <main aria-busy={busy}>
      {error && <div className="error" id="form-error" role="alert">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      {!settings && <section><h1>Запуск Neyra</h1><p>Загружаю локальные настройки…</p><p>Для работы нужен установленный десктоп-клиент.</p></section>}
      {tab === 'Сервер' && settings && <section><h1>Сервер</h1><p>Профили хранятся на этом ПК. Токены — в системном хранилище секретов.</p>
        <label>Профиль<select value={profileId} disabled={busy || connected} onChange={e => { setProfileId(e.target.value); setToken(''); setStatus(undefined); }}><option value="">Выберите сервер</option>{settings.profiles.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
        <button disabled={busy || connected || settings.profiles.length >= 12} onClick={() => { const p = newProfile(); setSettings({ ...settings, profiles: [...settings.profiles, p] }); setProfileId(p.id); }}>Добавить профиль</button>
        {profile && <><label>Название<input value={profile.name} maxLength={80} disabled={connected} onChange={e => patchProfile({ name: e.target.value })}/></label><label>Адрес сервера<input type="url" aria-describedby={error ? 'form-error' : undefined} aria-invalid={!validServerUrl(profile.url)} value={profile.url} disabled={connected} onChange={e => patchProfile({ url: e.target.value })}/></label><label>Токен<input type="password" value={token} autoComplete="off" disabled={connected} onChange={e => setToken(e.target.value)} placeholder="Оставьте пустым, чтобы использовать сохранённый"/></label><div className="actions"><button disabled={busy || connected} onClick={check}>Проверить подключение</button><button disabled={busy || connected} onClick={connect}>Подключить</button><button disabled={busy || !connected} onClick={() => run(async () => { await invoke('disconnect'); setConnected(false); setDevices([]); setTarget(''); })}>Отключить</button></div></>}
        <label>Имя этого ПК<input value={settings.device_name} maxLength={80} disabled={connected} onChange={e => setSettings({ ...settings, device_name: e.target.value })}/></label><label>Тема<select value={settings.theme} onChange={e => setSettings({ ...settings, theme: e.target.value })}><option value="dark">Тёмная</option><option value="light">Светлая</option></select></label><label>Графика Linux (после перезапуска)<select value={settings.graphics_mode} onChange={e => setSettings({ ...settings, graphics_mode: e.target.value })}><option value="auto">Автоматически</option><option value="wayland">Wayland</option><option value="wayland-nvidia">Wayland · NVIDIA explicit sync workaround</option><option value="x11">X11</option><option value="compatibility">Совместимость (может замедлять UI)</option></select></label><button disabled={busy} onClick={() => run(async () => { await save(settings); setNotice('Настройки сохранены'); })}>Сохранить настройки</button><p className="path">Данные: {root}</p><p className="path">Устройство: {settings.device_id}</p>
      </section>}
      {tab === 'Чат' && <section className="chat"><h1>Чат</h1><div ref={messagePanel} onScroll={e => { const el = e.currentTarget; followMessages.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} className="messages" aria-label="История чата">{history.length === 0 && <p>Здесь появится разговор с Нейрой.</p>}{history.map((entry, i) => <article key={i}><strong>{entry.role === 'user' ? 'Вы' : 'Нейра'}</strong><p>{entry.content}</p></article>)}{partial && <article><strong>Нейра</strong><p>{partial}</p></article>}</div>
        {lastTrace !== undefined && <details><summary>Модели последнего ответа</summary><pre>{JSON.stringify(lastTrace, null, 2)}</pre></details>}<label>ПК для действий<select value={target} disabled={!connected} onChange={e => setTarget(e.target.value)}><option value="">Этот ПК</option>{devices.map(d => <option key={d.device_id} value={d.device_id}>{d.name} · {d.device_id.slice(0, 8)}</option>)}</select></label><button onClick={updateDevices} disabled={!connected || busy}>Обновить устройства</button><button disabled={!connected || busy || !target} onClick={() => { if (window.confirm('Отключить выбранный ПК? Действия будут отменены, повторное подключение выполняется на том ПК вручную.')) void run(async () => { await invoke('disconnect_device', { deviceId: target }); setTarget(''); }); }}>Отключить выбранный ПК</button>
        <form onSubmit={e => { e.preventDefault(); void sendText(); }}><label>Сообщение<textarea value={text} onChange={e => setText(e.target.value)} maxLength={6000} disabled={!connected}/></label><div className="actions"><button disabled={busy || !connected || thinking || !text.trim()}>Отправить</button><button type="button" aria-pressed={recording} onClick={record} disabled={busy || !connected || (thinking && !recording)}>{recording ? 'Завершить и отправить' : 'Записать голос'}</button></div></form><p>{shortcuts ? 'Push-to-talk: удерживайте Ctrl+Alt+Space; Stop: Ctrl+Alt+Escape. Также доступны кнопки.' : 'Глобальные хоткеи недоступны: используйте кнопки записи и Stop.'} Аудио не сохраняется.</p>
      </section>}
      {tab === 'Статус' && <section><h1>Статус сервера</h1><button disabled={busy || !profileId} onClick={() => run(async () => { const out = await request('/v1/health'); setStatus(out.data); })}>Обновить статус</button>{status ? <pre>{JSON.stringify(status, null, 2)}</pre> : <p>Выберите сервер и проверьте подключение.</p>}</section>}
      {tab === 'Модули' && <section><h1>Модули</h1><div className="actions"><button disabled={busy || !profileId} onClick={() => run(async () => { const out = await request('/v1/plugins'); setPlugins((out.data as { plugins: Plugin[] }).plugins); })}>Обновить модули</button><button disabled={busy || !profileId} onClick={() => { if (window.confirm('Перезапустить ядро сервера? Активные ходы прервутся.')) void run(async () => { await request('/v1/system/restart', 'POST'); setNotice('Запрошен мягкий рестарт'); }); }}>Мягкий рестарт</button></div>{plugins.length === 0 && <p>Загрузите список модулей.</p>}{plugins.map(p => <article key={p.id}><h2>{p.name ?? p.id}</h2><p>{p.lifecycle ?? 'Модуль'} · {p.enabled ? 'Включён' : 'Выключен'}</p><button disabled={busy} onClick={() => { if (window.confirm('Изменить состояние модуля? Для resident ядро будет перезапущено.')) void run(async () => { await invoke('set_module', { profileId, moduleId: p.id, enabled: !p.enabled }); setPlugins(list => list.map(x => x.id === p.id ? { ...x, enabled: !x.enabled } : x)); }); }}>{p.enabled ? 'Выключить' : 'Включить'}</button></article>)}</section>}
      {tab === 'Доступ к ПК' && settings && <section><h1>Доступ к ПК</h1>{!pcAvailable && <p role="status">Доступ приостановлен: сессия заблокирована или ОС не подтвердила её состояние. Чат доступен.</p>}<p>Безопасное — сама, неизвестная программа или домен — с подтверждением. CLI, файлы, экран и ввод ещё недоступны.</p><label className="check"><input type="checkbox" checked={settings.permissions.enabled} onChange={e => void run(async () => { await save({ ...settings, permissions: { ...settings.permissions, enabled: e.target.checked } }); })}/>Разрешить Нейре управлять этим ПК</label><label className="check"><input type="checkbox" checked={settings.permissions.allow_web} onChange={e => void run(async () => { await save({ ...settings, permissions: { ...settings.permissions, allow_web: e.target.checked } }); })}/>Браузер: ссылки и поиск</label><label className="check"><input type="checkbox" checked={settings.permissions.system} onChange={e => void run(async () => { await save({ ...settings, permissions: { ...settings.permissions, system: e.target.checked } }); })}/>Приложения и система: окна и медиа (если доступны)</label>
        <label>Домены без подтверждения (через запятую)<input value={settings.permissions.web_domains.join(', ')} onChange={e => setSettings({ ...settings, permissions: { ...settings.permissions, web_domains: e.target.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) } })}/></label><button disabled={busy} onClick={() => run(async () => { await save(settings); setNotice('Список доменов сохранён'); })}>Сохранить домены</button><p>Неизвестные домены требуют подтверждения. Поиск открывается в Google.</p><h2>Разрешённые приложения</h2><button disabled={busy} onClick={() => run(async () => { setApplications(await invoke<string[]>('applications')); })}>Найти установленные приложения</button><label>Фильтр приложений<input value={appFilter} onChange={e => setAppFilter(e.target.value)}/></label><div className="app-list">{applications.filter(p => p.toLowerCase().includes(appFilter.toLowerCase())).slice(0, 40).map(path => <label className="check" key={path}><input type="checkbox" checked={settings.permissions.apps.includes(path)} onChange={e => void run(async () => { const apps = e.target.checked ? [...settings.permissions.apps, path] : settings.permissions.apps.filter(a => a !== path); await save({ ...settings, permissions: { ...settings.permissions, apps } }); })}/><span className="path">{path}</span></label>)}</div>
        <h2>Журнал действий</h2><p>30 дней, до 2000 записей. Без параметров команд и содержимого файлов.</p><button disabled={busy} onClick={() => run(async () => setAudit(await invoke<AuditRow[]>('audit_log')))}>Обновить журнал</button>{audit.length === 0 ? <p>Журнал пуст.</p> : <ol>{audit.slice(-50).reverse().map((r, i) => <li key={i}>{new Date(r.time).toLocaleString('ru-RU')} · {r.tool} · {r.status}{r.confirmed ? ' · подтверждено' : ''}</li>)}</ol>}
      </section>}
    </main>
    <dialog aria-labelledby="confirm-title" ref={modal} onCancel={e => { e.preventDefault(); void approve(false); }}><h2 id="confirm-title">Разрешить действие на этом ПК?</h2><p>{hostCall?.tool}</p><pre>{JSON.stringify(hostCall?.arguments, null, 2)}</pre><p>Подтверждение действует только для этого вызова, до 30 секунд.</p><div className="actions"><button autoFocus onClick={() => void approve(false)}>Отклонить</button><button onClick={() => void approve(true)}>Разрешить один раз</button></div></dialog>
  </div>;
}
