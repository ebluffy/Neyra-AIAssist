import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type AuditRow, type Settings } from '../types';

type Runner = (action: () => Promise<void>) => Promise<void>;
interface Props {
  settings: Settings; setSettings: (s: Settings) => void; save: (s: Settings) => Promise<void>; pcAvailable: boolean; busy: boolean;
  run: Runner; notify: (text: string) => void;
}

export function PermissionsScreen({ settings, setSettings, save, pcAvailable, busy, run, notify }: Props) {
  const [applications, setApplications] = useState<string[]>();
  const [appFilter, setAppFilter] = useState('');
  const [audit, setAudit] = useState<AuditRow[]>();
  const p = settings.permissions;
  const patch = (permissions: Partial<Settings['permissions']>) => void run(async () => { await save({ ...settings, permissions: { ...p, ...permissions } }); });
  const shown = (applications ?? []).filter(path => path.toLowerCase().includes(appFilter.toLowerCase()));

  return <section aria-labelledby="permissions-title">
    <h1 id="permissions-title">Доступ к ПК</h1>
    {!pcAvailable && <p role="status">Доступ приостановлен: сессия заблокирована или ОС не подтвердила её состояние. Чат доступен.</p>}
    <p>Безопасное Нейра делает сама; неизвестная программа/домен и опасные действия — с карточкой. Контуры 3–4 по умолчанию выключены.</p>
    <label className="check"><input type="checkbox" checked={p.enabled} disabled={busy} onChange={e => patch({ enabled: e.target.checked })}/>Разрешить Нейре управлять этим ПК</label>
    <label className="check"><input type="checkbox" checked={p.allow_web} disabled={busy} onChange={e => patch({ allow_web: e.target.checked })}/>Браузер: ссылки и поиск</label>
    <label className="check"><input type="checkbox" checked={p.system} disabled={busy} onChange={e => patch({ system: e.target.checked })}/>Приложения и система: окна и медиа (если доступны)</label>
    <h2>Контур 3 · CLI и файлы</h2>
    <label className="check"><input type="checkbox" checked={!!p.shell} disabled={busy || !p.enabled} onChange={e => patch({ shell: e.target.checked })}/>Консоль (каждая команда с подтверждением)</label>
    <label className="check"><input type="checkbox" checked={!!p.files} disabled={busy || !p.enabled} onChange={e => patch({ files: e.target.checked })}/>Файлы в разрешённых корнях</label>
    <label>Корни файловой системы (по одному пути на строку)<textarea value={(p.fs_roots ?? []).join('\n')} rows={3} disabled={busy || !p.files} onChange={e => setSettings({ ...settings, permissions: { ...p, fs_roots: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } })}/></label>
    <button disabled={busy || !p.files} onClick={() => run(async () => { await save(settings); notify('Корни FS сохранены'); })}>Сохранить корни FS</button>
    <h2>Контур 4 · Экран и ввод</h2>
    <label className="check"><input type="checkbox" checked={!!p.screen} disabled={busy || !p.enabled} onChange={e => patch({ screen: e.target.checked })}/>Скриншоты</label>
    <label className="check"><input type="checkbox" checked={!!p.screen_auto} disabled={busy || !p.screen} onChange={e => patch({ screen_auto: e.target.checked })}/>Скриншоты без карточки (только capture)</label>
    <label className="check"><input type="checkbox" checked={!!p.input} disabled={busy || !p.enabled} onChange={e => patch({ input: e.target.checked })}/>Мышь и клавиатура (каждая последовательность с подтверждением)</label>
    <label>Домены без подтверждения (через запятую)<input value={p.web_domains.join(', ')} onChange={e => setSettings({ ...settings, permissions: { ...p, web_domains: e.target.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) } })}/></label>
    <button disabled={busy} onClick={() => run(async () => { await save(settings); notify('Список доменов сохранён'); })}>Сохранить домены</button>
    <p>Неизвестные домены требуют подтверждения. Поиск открывается в Google.</p>
    <h2>Разрешённые приложения</h2>
    <button disabled={busy} onClick={() => run(async () => { setApplications(await invoke<string[]>('applications')); })}>Найти установленные приложения</button>
    <label>Фильтр приложений<input value={appFilter} onChange={e => setAppFilter(e.target.value)}/></label>
    {applications && applications.length === 0 && <p>Приложения не найдены. Проверьте, что программы установлены стандартным способом.</p>}
    {applications && applications.length > 0 && shown.length === 0 && <p>Ничего не найдено по фильтру.</p>}
    <div className="app-list">{shown.slice(0, 40).map(path => <label className="check" key={path}><input type="checkbox" checked={p.apps.includes(path)} onChange={e => patch({ apps: e.target.checked ? [...p.apps, path] : p.apps.filter(a => a !== path) })}/><span className="path">{path}</span></label>)}</div>
    {p.apps.length > 0 && <p>Разрешено приложений: {p.apps.length}.</p>}
    <h2>Журнал действий</h2>
    <p>{settings.audit_days} дн., до 2000 записей. Без параметров команд и содержимого файлов.</p>
    <button disabled={busy} onClick={() => run(async () => setAudit(await invoke<AuditRow[]>('audit_log')))}>Обновить журнал</button>
    {audit === undefined ? null : audit.length === 0 ? <p>Журнал пуст.</p> : <ol>{audit.slice(-50).reverse().map((r, i) => <li key={i}>{new Date(r.time).toLocaleString('ru-RU')} · {r.tool} · {r.status}{r.confirmed ? ' · подтверждено' : ''}</li>)}</ol>}
  </section>;
}
