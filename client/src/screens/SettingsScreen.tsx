import { useEffect, useRef, useState } from 'react';
import { THEMES } from '../theme';
import { invoke } from '@tauri-apps/api/core';
import { type ImportPreview, recoveryText } from '../commands';
import { type Recovery, type Settings } from '../types';

type Runner = (action: () => Promise<void>) => Promise<void>;
interface Props {
  settings: Settings; setSettings: (s: Settings) => void; saveSection: (patch: Partial<Settings>) => Promise<void>; root: string; recoveries: Recovery[];
  connected: boolean; busy: boolean; run: Runner; notify: (text: string) => void; applyImported: (s: Settings) => void;
  onTheme: (theme: string) => void;
}
const STATUS: Record<string, string> = { new: 'Новая', same: 'Совпадает', conflict: 'Конфликт имён', invalid: 'Ошибка' };
const BLOCKED: Record<string, string> = { allow_web: 'браузер', system: 'система', shell: 'консоль', files: 'файлы', screen: 'экран', screen_auto: 'снимки без подтверждения', input: 'ввод' };
function blockedLabels(keys: string[] | undefined): string {
  const names = (keys ?? []).map(key => BLOCKED[key]).filter(Boolean);
  return names.length ? `Файл включает выключенное сейчас: ${names.join(', ')}. Это не включится.` : '';
}

export function SettingsScreen({ settings, setSettings, saveSection, root, recoveries, connected, busy, run, notify, applyImported, onTheme }: Props) {
  const [preview, setPreview] = useState<ImportPreview>();
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [conflict, setConflict] = useState<'skip' | 'overwrite' | 'rename'>('rename');
  const [withSettings, setWithSettings] = useState(false);
  const [withPermissions, setWithPermissions] = useState(false);
  const [folderChoice, setFolderChoice] = useState<string | null>(null);
  const folderDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = folderDialog.current;
    if (!node) return;
    if (folderChoice) {
      if (!node.open) node.showModal();
      node.querySelector('button')?.focus();
    } else if (node.open) node.close();
  }, [folderChoice, busy]);
  const usable = preview?.items?.filter(i => i.status !== 'invalid').length ?? 0;

  const exportConfig = () => run(async () => {
    const out = await invoke<{ cancelled: boolean; commands?: number; file?: string }>('config_export');
    if (!out.cancelled) notify(`Сохранено: ${out.file ?? 'файл'} · команд: ${out.commands ?? 0}. Токены и журнал не включены.`);
  });
  const pick = () => run(async () => {
    const out = await invoke<ImportPreview>('import_pick');
    if (!out.cancelled) { setPreview(out); setWithSettings(false); setWithPermissions(false); }
  });
  const apply = () => run(async () => {
    if (mode === 'replace' && !window.confirm('Заменить все текущие команды? Старые файлы будут перенесены в резервную папку cache.')) return;
    const out = await invoke<{ report: { added: number; replaced: number; renamed: number; skipped: number }; settings: Settings }>('import_apply', { mode, conflict, includePermissions: withPermissions, includeSettings: withSettings });
    applyImported(out.settings); setPreview(undefined);
    const r = out.report; notify(`Импорт завершён: новых ${r.added}, заменено ${r.replaced}, переименовано ${r.renamed}, пропущено ${r.skipped}.`);
  });
  const cancelImport = () => run(async () => { await invoke('import_cancel'); setPreview(undefined); });
  const moveData = () => run(async () => {
    if (!window.confirm('Скопировать данные в выбранную папку? Старая папка останется на месте. Если там уже есть данные Neyra, вы сможете использовать их или заменить. До перезапуска сохранение будет отключено.')) return;
    const out = await invoke<{ cancelled: boolean; path?: string; needs_choice?: boolean }>('choose_data_root');
    if (out.cancelled) return;
    if (out.needs_choice && out.path) { setFolderChoice(out.path); return; }
    notify(`Данные скопированы в ${out.path}. Перезапустите Neyra. До перезапуска сохранение отключено.`);
  });
  const applyFolder = (choice: 'use_existing' | 'overwrite') => run(async () => {
    try {
      const out = await invoke<{ cancelled: boolean; path?: string }>('confirm_data_root', { choice });
      if (!out.cancelled) notify(`Папка данных: ${out.path}. Перезапустите Neyra. До перезапуска сохранение отключено.`);
    } finally {
      setFolderChoice(null);
    }
  });
  const cancelFolder = () => run(async () => {
    try {
      await invoke('confirm_data_root', { choice: 'cancel' });
    } finally {
      setFolderChoice(null);
    }
  });

  return <section aria-labelledby="settings-title">
    <h1 id="settings-title">Настройки</h1>
    {recoveries.length > 0 && <div className="error" role="alert"><strong>Часть файлов настроек была восстановлена</strong><ul>{recoveries.map((r, i) => <li key={i}>{recoveryText(r)}</li>)}</ul></div>}
    <div className="group">
    <h2>Этот ПК</h2>
    <label>Имя этого ПК<input value={settings.device_name} maxLength={80} disabled={connected} aria-describedby={connected ? 'name-locked' : undefined} onChange={e => setSettings({ ...settings, device_name: e.target.value })}/></label>
    {connected && <p className="hint" id="name-locked">Имя можно менять, когда клиент отключён от сервера.</p>}
    <fieldset className="theme-cards"><legend>Тема</legend>{THEMES.map(item => <label className="theme-card" key={item.id}><input type="radio" name="theme-choice" value={item.id} checked={settings.theme === item.id} onChange={() => onTheme(item.id)} /><span className={`swatch ${item.id}`} aria-hidden="true" />{item.label}</label>)}</fieldset>
    <label>Графика Linux (после перезапуска)<select value={settings.graphics_mode} onChange={e => setSettings({ ...settings, graphics_mode: e.target.value })}><option value="auto">Автоматически</option><option value="wayland">Wayland</option><option value="wayland-nvidia">Wayland · NVIDIA explicit sync workaround</option><option value="x11">X11</option><option value="compatibility">Совместимость (может замедлять UI)</option></select></label>
    <div className="planned"><p className="hint">Персонаж на рабочем столе — в разработке, после шага 7. Отсюда он не включается.</p></div>
    <label>Хранить журнал действий, дней<input type="number" min={1} max={365} value={settings.audit_days} onChange={e => setSettings({ ...settings, audit_days: Math.min(365, Math.max(1, Number(e.target.value) || 30)) })}/></label>
    <button disabled={busy} onClick={() => run(async () => { await saveSection({ device_name: settings.device_name, theme: settings.theme, graphics_mode: settings.graphics_mode, audit_days: settings.audit_days }); notify('Настройки сохранены'); })}>Сохранить настройки</button>
    </div>
    <div className="group">
    <h2>Данные на этом ПК</h2>
    <p>Команды, разрешения, журнал и настройки лежат в папке ниже. Токены сервера в неё не попадают: они хранятся в системном хранилище секретов.</p>
    <p className="path">{root}</p><p className="path">Устройство: {settings.device_id}</p>
    <button disabled={busy} onClick={moveData}>Сменить папку данных…</button>
    </div>
    <dialog ref={folderDialog} className="editor" aria-labelledby="data-move-title" onCancel={event => { event.preventDefault(); cancelFolder(); }}>
      {folderChoice && <>
        <h2 id="data-move-title">В папке уже есть данные Neyra</h2>
        <p>Папка <span className="path">{folderChoice}</span> уже содержит настройки. Можно открыть её как есть или заменить текущими данными. Прежняя папка этого запуска останется на месте. Заменяемые данные будут отложены рядом, в папку с суффиксом <span className="path">.previous</span>.</p>
        <div className="actions">
          <button autoFocus onClick={cancelFolder}>Отмена</button>
          <button disabled={busy} onClick={() => applyFolder('use_existing')}>Использовать эти данные</button>
          <button disabled={busy} onClick={() => applyFolder('overwrite')}>Заменить текущими</button>
        </div>
      </>}
    </dialog>
    <div className="group">
    <h2>Перенос конфигурации</h2>
    <p>Файл содержит настройки, разрешения и быстрые команды. Без токенов, адресов серверов и журнала. Импортированные команды работают по тем же правилам безопасности этого ПК.</p>
    <div className="actions"><button disabled={busy} onClick={exportConfig}>Экспортировать…</button><button disabled={busy} onClick={pick}>Импортировать…</button></div>
    {preview?.items && <div className="import" role="group" aria-label="Предпросмотр импорта">
      <h3>Предпросмотр импорта</h3>
      {preview.items.length === 0 ? <p>В файле нет команд.</p> : <ul>{preview.items.map((item, i) => <li key={i}><strong>{item.name}</strong> · {STATUS[item.status]}{item.error ? ` · ${item.error}` : ''}</li>)}</ul>}
      <label>Режим<select value={mode} onChange={e => setMode(e.target.value as 'merge' | 'replace')}><option value="merge">Добавить к текущим</option><option value="replace">Заменить текущие (с резервной копией)</option></select></label>
      <label>Если имя уже занято<select value={conflict} onChange={e => setConflict(e.target.value as 'skip' | 'overwrite' | 'rename')}><option value="rename">Сохранить под новым именем</option><option value="skip">Пропустить</option><option value="overwrite">Заменить существующую</option></select></label>
      <label className="check"><input type="checkbox" checked={withSettings} onChange={e => setWithSettings(e.target.checked)}/>Применить тему и графику из файла</label>
      <label className="check"><input type="checkbox" checked={withPermissions} onChange={e => setWithPermissions(e.target.checked)}/>Применить разрешения из файла (главный выключатель не включится)</label>
      {withPermissions && preview.permissions && <p className="hint">Браузер: {preview.permissions.allow_web ? 'да' : 'нет'} · приложения и система: {preview.permissions.system ? 'да' : 'нет'}. Домены, которые останутся: {preview.permissions.web_domains.join(', ') || 'нет'}. Программы, которые останутся: {preview.permissions.apps.join(', ') || 'нет'}. Новые домены и программы из файла не добавляются. {blockedLabels(preview.permissions.blocked)}</p>}
      <div className="actions"><button onClick={cancelImport} disabled={busy}>Отмена</button><button className="primary" disabled={busy || (usable === 0 && !withSettings && !withPermissions)} onClick={apply}>Применить импорт</button></div>
    </div>}
    </div>
  </section>;
}
