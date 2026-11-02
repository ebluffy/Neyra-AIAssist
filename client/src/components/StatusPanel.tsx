import type { Plugin } from '../types';

export function StatusPanel({ busy, profileId, status, plugins, onStatus, onPlugins, onRestart, onToggle }: { busy: boolean; profileId: string; status: unknown; plugins: Plugin[]; onStatus: () => void; onPlugins: () => void; onRestart: () => void; onToggle: (plugin: Plugin) => void }) {
  return <section aria-labelledby="status-title">
    <h1 id="status-title">Состояние и модули</h1>
    <h2>Статус сервера</h2>
    <button type="button" disabled={busy || !profileId} onClick={onStatus}>Обновить статус</button>
    {status ? <pre>{JSON.stringify(status, null, 2)}</pre> : <p>Выберите сервер и проверьте подключение.</p>}
    <h2>Модули</h2>
    <div className="actions">
      <button type="button" disabled={busy || !profileId} onClick={onPlugins}>Обновить модули</button>
      <button type="button" disabled={busy || !profileId} onClick={onRestart}>Мягкий рестарт</button>
    </div>
    {plugins.length === 0 && <p>Загрузите список модулей.</p>}
    {plugins.map(plugin => <article key={plugin.id}><h3>{plugin.name ?? plugin.id}</h3><p>{plugin.lifecycle ?? 'Модуль'} · {plugin.enabled ? 'Включён' : 'Выключен'}</p><button type="button" disabled={busy} onClick={() => onToggle(plugin)}>{plugin.enabled ? 'Выключить' : 'Включить'}</button></article>)}
  </section>;
}
