import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type AuditRow, type Permissions, type Settings } from '../types';
import { absoluteRoot } from './validation';

type Runner = (action: () => Promise<void>) => Promise<void>;
interface Props {
  settings: Settings; setSettings: (s: Settings) => void; saveSection: (patch: Partial<Settings>) => Promise<void>; pcAvailable: boolean; busy: boolean;
  run: Runner; notify: (text: string) => void; backends: { screen: boolean; input: boolean };
}

export function PermissionsScreen({ settings, setSettings, saveSection, pcAvailable, busy, run, notify, backends }: Props) {
  const [applications, setApplications] = useState<string[]>();
  const [appFilter, setAppFilter] = useState('');
  const [audit, setAudit] = useState<AuditRow[]>();
  const [newRoot, setNewRoot] = useState('');
  const newRootInput = useRef<HTMLInputElement>(null);
  const rootsInput = useRef<HTMLTextAreaElement>(null);
  const domainsInput = useRef<HTMLInputElement>(null);
  const p = settings.permissions;
  const patch = (permissions: Partial<Permissions>, warning?: string) => run(async () => {
    if (warning && !window.confirm(warning)) return;
    await saveSection({ permissions: { ...p, ...permissions } });
  });
  const addRoot = () => run(async () => {
    const path = newRoot.trim();
    if (!absoluteRoot(path)) { newRootInput.current?.focus(); return; }
    if (p.fs_roots.includes(path)) return;
    await saveSection({ permissions: { ...p, fs_roots: [...p.fs_roots, path] } });
    setNewRoot(''); notify('Папка разрешена');
  });
  const shown = (applications ?? []).filter(path => path.toLowerCase().includes(appFilter.toLowerCase()));
  const invalidNewRoot = !!newRoot.trim() && !absoluteRoot(newRoot.trim());
  const invalidRoots = p.fs_roots.some(path => !absoluteRoot(path));
  const invalidDomains = p.web_domains.some(domain => {
    try {
      const url = new URL(`https://${domain}`);
      return url.hostname !== domain || url.pathname !== '/' || !!url.port;
    } catch { return true; }
  });

  return <section aria-labelledby="permissions-title">
    <h1 id="permissions-title">Доступ к ПК</h1>
    {busy && <p id="permissions-busy" role="status">Дождитесь завершения текущего действия, чтобы изменить разрешения.</p>}
    {!pcAvailable && <p role="status">Доступ приостановлен: сессия заблокирована или ОС не подтвердила её состояние. Чат доступен.</p>}
    <p>Безопасное — сама, опасное — с подтверждением. Консоль, файлы, экран и ввод выключены, пока вы их не включите.</p>
    <label className="check"><input name="permissions-enabled" autoComplete="off" type="checkbox" checked={p.enabled} disabled={busy} aria-describedby={busy ? 'permissions-busy' : undefined} onChange={e => patch({ enabled: e.target.checked })}/>Разрешить Нейре управлять этим ПК</label>
    {!p.enabled && <p id="permissions-master-hint" className="hint">Включите управление этим ПК, чтобы изменить зависимые разрешения.</p>}
    <label className="check"><input name="permissions-web" autoComplete="off" type="checkbox" checked={p.allow_web} disabled={busy} aria-describedby={busy ? 'permissions-busy' : undefined} onChange={e => patch({ allow_web: e.target.checked })}/>Браузер: ссылки и поиск</label>
    <label className="check"><input name="permissions-system" autoComplete="off" type="checkbox" checked={p.system} disabled={busy} aria-describedby={busy ? 'permissions-busy' : undefined} onChange={e => patch({ system: e.target.checked })}/>Приложения и система: окна и медиа (если доступны)</label>
    <h2>Контур 3 · CLI и файлы</h2>
    <label className="check"><input name="permissions-contour-shell" autoComplete="off" type="checkbox" checked={!!p.shell} disabled={busy || !p.enabled} aria-describedby={busy ? 'permissions-busy' : !p.enabled ? 'permissions-master-hint' : undefined} onChange={e => patch({ shell: e.target.checked })}/>Консоль (каждая команда с подтверждением)</label>
    <label className="check"><input name="permissions-contour-files" autoComplete="off" type="checkbox" checked={!!p.files} disabled={busy || !p.enabled} aria-describedby={busy ? 'permissions-busy' : !p.enabled ? 'permissions-master-hint' : undefined} onChange={e => patch({ files: e.target.checked })}/>Файлы в разрешённых корнях</label>
    {!p.files && <p id="permissions-files-hint" className="hint">Включите доступ к файлам, чтобы изменить список разрешённых корней.</p>}
    <label>Корни файловой системы (по одному пути на строку)<textarea ref={rootsInput} name="filesystem-roots" autoComplete="off" spellCheck={false} value={(p.fs_roots ?? []).join('\n')} rows={3} disabled={busy || !p.files} aria-invalid={invalidRoots} aria-describedby={busy ? 'permissions-busy' : !p.files ? 'permissions-files-hint' : invalidRoots ? 'filesystem-roots-error' : undefined} onChange={e => setSettings({ ...settings, permissions: { ...p, fs_roots: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } })}/></label>
    {invalidRoots && <p id="filesystem-roots-error" className="field-error" role="alert">Укажите полный путь в каждой строке, например /home/имя/Documents или C:\Users\имя\Documents.</p>}
    <button disabled={busy || !p.files} onClick={() => { if (invalidRoots) { rootsInput.current?.focus(); return; } void run(async () => { await saveSection({ permissions: settings.permissions }); notify('Корни файловой системы сохранены'); }); }}>Сохранить корни файловой системы</button>
    <h2>Контур 4 · Экран и ввод</h2>
    <label className="check"><input name="permissions-contour-screen" autoComplete="off" type="checkbox" checked={!!p.screen} disabled={busy || !p.enabled} aria-describedby={busy ? 'permissions-busy' : !p.enabled ? 'permissions-master-hint' : undefined} onChange={e => patch({ screen: e.target.checked })}/>Скриншоты</label>
    {!p.screen && <p id="permissions-screen-hint" className="hint">Включите снимки экрана, чтобы разрешить их без подтверждения.</p>}
    <label className="check"><input name="permissions-contour-screen-auto" autoComplete="off" type="checkbox" checked={!!p.screen_auto} disabled={busy || !p.screen} aria-describedby={busy ? 'permissions-busy' : !p.screen ? 'permissions-screen-hint' : undefined} onChange={e => patch({ screen_auto: e.target.checked })}/>Скриншоты без карточки (только capture)</label>
    <label className="check"><input name="permissions-contour-input" autoComplete="off" type="checkbox" checked={!!p.input} disabled={busy || !p.enabled} aria-describedby={busy ? 'permissions-busy' : !p.enabled ? 'permissions-master-hint' : undefined} onChange={e => patch({ input: e.target.checked })}/>Мышь и клавиатура (каждая последовательность с подтверждением)</label>
    <label>Домены без подтверждения (через запятую)<input ref={domainsInput} name="allowed-domains" type="text" inputMode="url" autoComplete="off" spellCheck={false} value={p.web_domains.join(', ')} aria-invalid={invalidDomains} aria-describedby={invalidDomains ? 'allowed-domains-error' : undefined} onChange={e => setSettings({ ...settings, permissions: { ...p, web_domains: e.target.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) } })}/></label>
    {invalidDomains && <p id="allowed-domains-error" className="field-error" role="alert">Укажите домены без протокола, пути и порта, например example.com.</p>}
    <button disabled={busy} onClick={() => { if (invalidDomains) { domainsInput.current?.focus(); return; } void run(async () => { await saveSection({ permissions: settings.permissions }); notify('Список доменов сохранён'); }); }}>Сохранить домены</button>
    <p>Неизвестные домены требуют подтверждения. Поиск открывается в Google.</p>
    <h2>Разрешённые приложения</h2>
    <button disabled={busy} onClick={() => run(async () => { setApplications(await invoke<string[]>('applications')); })}>Найти установленные приложения</button>
    <label>Фильтр приложений<input name="application-filter" type="search" autoComplete="off" spellCheck={false} value={appFilter} onChange={e => setAppFilter(e.target.value)}/></label>
    {applications && applications.length === 0 && <p>Приложения не найдены. Проверьте, что программы установлены стандартным способом.</p>}
    {applications && applications.length > 0 && shown.length === 0 && <p>Ничего не найдено по фильтру.</p>}
    <div className="app-list">{shown.slice(0, 40).map(path => <label className="check" key={path}><input name={`allowed-app-${path}`} autoComplete="off" type="checkbox" checked={p.apps.includes(path)} onChange={e => patch({ apps: e.target.checked ? [...p.apps, path] : p.apps.filter(a => a !== path) })}/><span className="path">{path}</span></label>)}</div>
    {p.apps.length > 0 && <p>Разрешено приложений: {p.apps.length}.</p>}
    <h2>Консоль и файлы</h2>
    <label className="check"><input name="permissions-shell" autoComplete="off" type="checkbox" checked={p.shell} disabled={busy} aria-describedby={busy ? 'permissions-busy' : undefined} onChange={e => patch({ shell: e.target.checked }, e.target.checked ? 'Разрешить Нейре предлагать команды консоли? Каждая команда будет показана вам целиком и выполнится только после «Разрешить». Повышение прав запрещено.' : undefined)}/>Консоль (PowerShell, cmd, bash): каждая команда с подтверждением</label>
    <label className="check"><input name="permissions-files" autoComplete="off" type="checkbox" checked={p.files} disabled={busy || p.fs_roots.length === 0} aria-describedby={busy ? 'permissions-busy' : p.fs_roots.length === 0 ? 'permissions-roots-hint' : undefined} onChange={e => patch({ files: e.target.checked })}/>Файлы в разрешённых папках: чтение и поиск — сама, запись и перемещение — с подтверждением</label>
    {p.fs_roots.length === 0 && <p id="permissions-roots-hint">Сначала добавьте папку. Ключи, пароли, профили браузеров и папка Neyra закрыты всегда.</p>}
    <ul className="roots">{p.fs_roots.map(r => <li key={r}><span className="path">{r}</span><button disabled={busy} onClick={() => { const fs_roots = p.fs_roots.filter(x => x !== r); void patch({ fs_roots, files: fs_roots.length > 0 && p.files }); }}>Убрать</button></li>)}</ul>
    <form onSubmit={e => { e.preventDefault(); void addRoot(); }}><label>Новая разрешённая папка<input ref={newRootInput} name="new-filesystem-root" type="text" autoComplete="off" spellCheck={false} value={newRoot} aria-invalid={invalidNewRoot} aria-describedby={invalidNewRoot ? 'new-filesystem-root-error' : undefined} onChange={e => setNewRoot(e.target.value)} placeholder="Например, /home/имя/Documents…"/></label>{invalidNewRoot && <p id="new-filesystem-root-error" className="field-error" role="alert">Укажите полный путь к папке, например /home/имя/Documents или C:\Users\имя\Documents.</p>}<button disabled={busy || !newRoot.trim()}>Добавить папку</button></form>
    <h2>Экран, мышь и клавиатура</h2>
    {!backends.screen && !backends.input && <p role="status">В этой сессии ОС не дала доступ к экрану (нет X11 или портала Wayland). Нейре эти инструменты не предлагаются.</p>}
    <label className="check"><input name="permissions-screen" autoComplete="off" type="checkbox" checked={p.screen} disabled={busy} aria-describedby={busy ? 'permissions-busy' : undefined} onChange={e => patch({ screen: e.target.checked, screen_auto: e.target.checked && p.screen_auto })}/>Снимки экрана{backends.screen ? '' : ' (недоступно в этой сессии)'} — окна Neyra на время снимка скрываются</label>
    <label className="check"><input name="permissions-screen-auto" autoComplete="off" type="checkbox" checked={p.screen_auto} disabled={busy || !p.screen} aria-describedby={busy ? 'permissions-busy' : !p.screen ? 'permissions-screen-hint' : undefined} onChange={e => patch({ screen_auto: e.target.checked }, e.target.checked ? 'Снимки экрана без подтверждения? Нейра сможет видеть всё, что открыто на экране, пока доступ включён.' : undefined)}/>Снимки без подтверждения</label>
    <label className="check"><input name="permissions-input" autoComplete="off" type="checkbox" checked={p.input} disabled={busy} aria-describedby={busy ? 'permissions-busy' : undefined} onChange={e => patch({ input: e.target.checked }, e.target.checked ? 'Разрешить Нейре предлагать клики и ввод текста? Каждая последовательность будет показана целиком и выполнится только после «Разрешить». Стоп прерывает её посередине.' : undefined)}/>Мышь и клавиатура{backends.input ? '' : ' (недоступно в этой сессии)'}: каждая последовательность с подтверждением</label>
    <p>Нейра не вводит пароли и платёжные данные и не отправляет формы без вашего подтверждения. Stop, Ctrl+Alt+Escape или пункт трея прерывают действие.</p>
    <h2>Журнал действий</h2>
    <p>{settings.audit_days} дн., до 2000 записей. Без параметров команд и содержимого файлов.</p>
    <button disabled={busy} onClick={() => run(async () => setAudit(await invoke<AuditRow[]>('audit_log')))}>Обновить журнал</button>
    {audit === undefined ? null : audit.length === 0 ? <p>Журнал пуст.</p> : <ol>{audit.slice(-50).reverse().map((r, i) => <li key={i}>{new Date(r.time).toLocaleString('ru-RU')} · {r.tool} · {r.status}{r.confirmed ? ' · подтверждено' : ''}</li>)}</ol>}
  </section>;
}
