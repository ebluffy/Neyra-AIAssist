import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type AuditRow, type Permissions, type Settings, absolutePath } from '../types';

type Runner = (action: () => Promise<void>) => Promise<void>;
interface Props {
  settings: Settings; setSettings: (s: Settings) => void; save: (s: Settings) => Promise<void>; pcAvailable: boolean; busy: boolean;
  run: Runner; notify: (text: string) => void; backends: { screen: boolean; input: boolean };
}

export function PermissionsScreen({ settings, setSettings, save, pcAvailable, busy, run, notify, backends }: Props) {
  const [applications, setApplications] = useState<string[]>();
  const [appFilter, setAppFilter] = useState('');
  const [audit, setAudit] = useState<AuditRow[]>();
  const [newRoot, setNewRoot] = useState('');
  const p = settings.permissions;
  const patch = (permissions: Partial<Permissions>, warning?: string) => run(async () => {
    if (warning && !window.confirm(warning)) return;
    await save({ ...settings, permissions: { ...p, ...permissions } });
  });
  const addRoot = () => run(async () => {
    const path = newRoot.trim();
    if (!absolutePath(path)) throw 'Укажите полный путь к папке, например /home/имя/Documents или C:\\Users\\имя\\Documents.';
    if (p.fs_roots.includes(path)) return;
    await save({ ...settings, permissions: { ...p, fs_roots: [...p.fs_roots, path] } });
    setNewRoot(''); notify('Папка разрешена');
  });
  const shown = (applications ?? []).filter(path => path.toLowerCase().includes(appFilter.toLowerCase()));

  return <section aria-labelledby="permissions-title">
    <h1 id="permissions-title">Доступ к ПК</h1>
    {!pcAvailable && <p role="status">Доступ приостановлен: сессия заблокирована или ОС не подтвердила её состояние. Чат доступен.</p>}
    <p>Безопасное — сама, опасное — с подтверждением. Консоль, файлы, экран и ввод выключены, пока вы их не включите.</p>
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
    <h2>Консоль и файлы</h2>
    <label className="check"><input type="checkbox" checked={p.shell} disabled={busy} onChange={e => patch({ shell: e.target.checked }, e.target.checked ? 'Разрешить Нейре предлагать команды консоли? Каждая команда будет показана вам целиком и выполнится только после «Разрешить». Повышение прав запрещено.' : undefined)}/>Консоль (PowerShell, cmd, bash): каждая команда с подтверждением</label>
    <label className="check"><input type="checkbox" checked={p.files} disabled={busy || p.fs_roots.length === 0} onChange={e => patch({ files: e.target.checked })}/>Файлы в разрешённых папках: чтение и поиск — сама, запись и перемещение — с подтверждением</label>
    {p.fs_roots.length === 0 && <p>Сначала добавьте папку. Ключи, пароли, профили браузеров и папка Neyra закрыты всегда.</p>}
    <ul className="roots">{p.fs_roots.map(r => <li key={r}><span className="path">{r}</span><button disabled={busy} onClick={() => { const fs_roots = p.fs_roots.filter(x => x !== r); void patch({ fs_roots, files: fs_roots.length > 0 && p.files }); }}>Убрать</button></li>)}</ul>
    <form onSubmit={e => { e.preventDefault(); void addRoot(); }}><label>Новая разрешённая папка<input value={newRoot} onChange={e => setNewRoot(e.target.value)} placeholder="/home/имя/Documents"/></label><button disabled={busy || !newRoot.trim()}>Добавить папку</button></form>
    <h2>Экран, мышь и клавиатура</h2>
    {!backends.screen && !backends.input && <p role="status">В этой сессии ОС не дала доступ к экрану (нет X11 или портала Wayland). Нейре эти инструменты не предлагаются.</p>}
    <label className="check"><input type="checkbox" checked={p.screen} disabled={busy} onChange={e => patch({ screen: e.target.checked, screen_auto: e.target.checked && p.screen_auto })}/>Снимки экрана{backends.screen ? '' : ' (недоступно в этой сессии)'} — окна Neyra на время снимка скрываются</label>
    <label className="check"><input type="checkbox" checked={p.screen_auto} disabled={busy || !p.screen} onChange={e => patch({ screen_auto: e.target.checked }, e.target.checked ? 'Снимки экрана без подтверждения? Нейра сможет видеть всё, что открыто на экране, пока доступ включён.' : undefined)}/>Снимки без подтверждения</label>
    <label className="check"><input type="checkbox" checked={p.input} disabled={busy} onChange={e => patch({ input: e.target.checked }, e.target.checked ? 'Разрешить Нейре предлагать клики и ввод текста? Каждая последовательность будет показана целиком и выполнится только после «Разрешить». Stop прерывает её посередине.' : undefined)}/>Мышь и клавиатура{backends.input ? '' : ' (недоступно в этой сессии)'}: каждая последовательность с подтверждением</label>
    <p>Нейра не вводит пароли и платёжные данные и не отправляет формы без вашего подтверждения. Stop, Ctrl+Alt+Escape или пункт трея прерывают действие.</p>
    <h2>Журнал действий</h2>
    <p>{settings.audit_days} дн., до 2000 записей. Без параметров команд и содержимого файлов.</p>
    <button disabled={busy} onClick={() => run(async () => setAudit(await invoke<AuditRow[]>('audit_log')))}>Обновить журнал</button>
    {audit === undefined ? null : audit.length === 0 ? <p>Журнал пуст.</p> : <ol>{audit.slice(-50).reverse().map((r, i) => <li key={i}>{new Date(r.time).toLocaleString('ru-RU')} · {r.tool} · {r.status}{r.confirmed ? ' · подтверждено' : ''}</li>)}</ol>}
  </section>;
}
