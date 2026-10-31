import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { formatError } from './types';

interface UpdaterSettings { schema_version: number; channel: 'beta' | 'stable'; auto_check: boolean }
interface UpdaterState { settings: UpdaterSettings; current_version: string; endpoint: string; key_configured: boolean; install_kind: string; pending_version: string | null }
interface CheckResult { available: boolean; version?: string; notes?: string | null; date?: string | null }

let startupChecked = false;

export function UpdatesPanel() {
  const [state, setState] = useState<UpdaterState>();
  const [result, setResult] = useState<CheckResult>();
  const [progress, setProgress] = useState<{ downloaded: number; total?: number }>();
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  const check = useCallback(async () => {
    setBusy(true); setMessage('');
    try { setResult(await invoke<CheckResult>('update_check')); } catch (error) { setMessage(formatError(error)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const next = await invoke<UpdaterState>('update_state');
        if (!mounted.current) return;
        setState(next);
        if (next.settings.auto_check && next.key_configured && !startupChecked) { startupChecked = true; await check(); }
      } catch (error) { setMessage(formatError(error)); }
    })();
    const unlisten = listen<{ downloaded: number; total?: number }>('update-progress', ({ payload }) => setProgress(payload));
    return () => { mounted.current = false; void unlisten.then(off => off()); };
  }, [check]);
  const save = async (settings: UpdaterSettings) => {
    try { setState(await invoke<UpdaterState>('update_save', { settings })); setResult(undefined); setMessage(''); } catch (error) { setMessage(formatError(error)); }
  };
  const install = async () => {
    setBusy(true); setMessage('');
    try { await invoke('update_install'); setInstalled(true); } catch (error) { setMessage(formatError(error)); } finally { setBusy(false); }
  };
  if (!state) return <section aria-labelledby="updates-title"><h2 id="updates-title">Обновления</h2><p role="status">{message || 'Загружаю…'}</p></section>;
  return <section aria-labelledby="updates-title">
    <h2 id="updates-title">Обновления</h2>
    <p>Версия {state.current_version}. Подпись обновления проверяется всегда; без неё файл не ставится. Установка не меняет разрешения для ПК и данные в папке Neyra.</p>
    {!state.key_configured && <p role="alert" className="error">В этой сборке не задан публичный ключ подписи, автообновление отключено.</p>}
    {message && <p role="alert" className="error">{message}</p>}
    <label>Канал<select value={state.settings.channel} disabled={busy} onChange={e => void save({ ...state.settings, channel: e.target.value as UpdaterSettings['channel'] })}><option value="beta">Бета</option><option value="stable">Стабильный</option></select></label>
    <label className="check"><input type="checkbox" checked={state.settings.auto_check} onChange={e => void save({ ...state.settings, auto_check: e.target.checked })}/>Проверять при запуске</label>
    <div className="actions"><button disabled={busy || !state.key_configured} onClick={() => void check()}>Проверить обновления</button></div>
    {result && !result.available && <p role="status">Установлена последняя версия.</p>}
    {result?.available && !installed && <div role="status"><p>Доступна версия {result.version}.</p>{result.notes && <pre>{result.notes}</pre>}{progress && <p>Скачано {progress.downloaded}{progress.total ? ` из ${progress.total}` : ''} байт</p>}<div className="actions"><button disabled={busy} onClick={() => void install()}>Скачать и установить</button></div></div>}
    {installed && <div role="status"><p>Обновление установлено. Перезапустите Neyra, чтобы применить его.</p><div className="actions"><button onClick={() => void invoke('update_restart')}>Перезапустить</button></div></div>}
  </section>;
}
