import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type CommandEntry, type CommandsView, type Preview, VERDICT_LABEL, emptyCommand, locationText, summarizeActions, summarizeTriggers } from '../commands';
import { formatError } from '../types';
import { CommandEditor } from './CommandEditor';

type Runner = (action: () => Promise<void>) => Promise<void>;
interface Props { busy: boolean; run: Runner; notify: (text: string) => void; runLine: string; running: boolean }
interface EditorState { file: string | null; entry?: CommandEntry; yaml: boolean }

export function CommandsScreen({ busy, run, notify, runLine, running }: Props) {
  const [view, setView] = useState<CommandsView>();
  const [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState<EditorState>();
  const [previews, setPreviews] = useState<Record<string, Preview[]>>({});
  const [phrase, setPhrase] = useState('');

  const load = useCallback(() => {
    return invoke<CommandsView>('commands_list').then(v => { setLoadError(''); setView(v); }).catch(e => setLoadError(formatError(e)));
  }, []);
  useEffect(() => {
    void load();
    const changed = listen<CommandsView>('commands-changed', ({ payload }) => setView(payload));
    return () => { void changed.then(unlisten => unlisten()); };
  }, [load]);

  const act = (action: () => Promise<unknown>) => run(async () => { await action(); await load(); });
  const test = (file: string) => run(async () => { const rows = await invoke<Preview[]>('command_dry_run', { file }); setPreviews(p => ({ ...p, [file]: rows })); });
  const say = () => run(async () => {
    const result = await invoke<{ handled: boolean; command?: string; ambiguous?: string[] }>('command_run_phrase', { text: phrase });
    if (result.handled) setPhrase('');
    else notify(result.ambiguous ? `Фраза подходит нескольким командам: ${result.ambiguous.join(', ')}. Уточните её.` : 'Такой команды нет. В чате эта фраза уйдёт Нейре как обычное сообщение.');
  });

  return <section aria-labelledby="commands-title">
    <h1 id="commands-title">Быстрые команды</h1>
    <p>Команды хранятся только на этом ПК и работают без сервера. Из Discord, Telegram и dashboard они недоступны. Опасное действие всё равно спросит подтверждение.</p>
    <p className="path">Папка: {view?.folder ?? '…'}</p>
    {loadError && <div className="error" role="alert">{loadError} <button onClick={() => void load()}>Повторить</button></div>}
    {!view && !loadError && <p role="status">Загружаю команды…</p>}
    {view && !view.hotkeys_available && <p className="hint">Глобальные хоткеи здесь недоступны (например, Wayland): запускайте команды фразой или кнопкой.</p>}
    <div className="actions">
      <button className="primary" disabled={busy || !view || view.commands.length >= view.max_commands} onClick={() => setEditor({ file: null, yaml: false })}>Создать команду</button>
      <button disabled={busy || !view} onClick={() => setEditor({ file: null, yaml: true })}>Создать из YAML</button>
      <button disabled={busy} onClick={() => void load()}>Обновить</button>
    </div>
    <form className="phrase" onSubmit={e => { e.preventDefault(); void say(); }}>
      <label>Проверить фразу без сервера<input value={phrase} maxLength={300} onChange={e => setPhrase(e.target.value)} placeholder="режим игры"/></label>
      <button disabled={busy || running || !phrase.trim()}>Выполнить фразу</button>
    </form>
    <p role="status" className="runline">{runLine}</p>
    {running && <button className="stop" onClick={() => void run(async () => { await invoke('stop'); })}>Остановить команду</button>}
    {view && view.errors.length > 0 && <div className="error" role="alert"><strong>Проблемы в файлах команд</strong><ul>{view.errors.map((e, i) => <li key={i}><span className="path">{locationText(e)}</span>: {e.reason}{e.kept_previous ? ' (работает последняя рабочая версия)' : ' (файл пропущен)'}</li>)}</ul></div>}
    {view && view.commands.length === 0 && !loadError && <div className="empty"><h2>Команд пока нет</h2><p>Создайте команду в форме, положите YAML-файл в папку выше или скажите Нейре: «запомни команду: когда я говорю „режим игры“, открой Steam».</p></div>}
    <ul className="cards" aria-label="Список команд">
      {view?.commands.map(entry => {
        const c = entry.command;
        return <li key={entry.file} className={c.enabled ? '' : 'off'}>
          <h2>{c.name}</h2>
          {c.description && <p>{c.description}</p>}
          <p className="meta">{summarizeTriggers(c)}</p>
          <p className="meta">{summarizeActions(c)}{c.confirm ? ' · спросит перед запуском' : ''}{c.risk === 'confirm' ? ' · требует подтверждения' : ''}</p>
          {entry.hotkeys.filter(h => !h.registered).map(h => <p className="hint" key={h.hotkey}>Хоткей {h.hotkey} не зарегистрирован: занят системой или недоступен.</p>)}
          <label className="check"><input type="checkbox" checked={c.enabled} disabled={busy} onChange={e => void act(() => invoke('command_set_enabled', { file: entry.file, enabled: e.target.checked }))}/>Включена</label>
          <div className="actions">
            <button disabled={busy || running || !c.enabled} onClick={() => void run(async () => { await invoke('command_run', { file: entry.file }); })}>Запустить</button>
            <button disabled={busy} onClick={() => void test(entry.file)}>Проверить</button>
            <button disabled={busy} onClick={() => setEditor({ file: entry.file, entry, yaml: false })}>Изменить</button>
            <button disabled={busy} onClick={() => setEditor({ file: entry.file, entry, yaml: true })}>YAML</button>
            <button disabled={busy} onClick={() => { if (window.confirm(`Удалить команду «${c.name}»? Файл ${entry.file} будет удалён.`)) void act(() => invoke('command_delete', { file: entry.file })); }}>Удалить</button>
          </div>
          {previews[entry.file] && <ol className="preview" aria-label={`Проверка команды ${c.name}`}>{previews[entry.file].map(p => <li key={p.step}><strong>Шаг {p.step}</strong> · {VERDICT_LABEL[p.verdict]} · {p.message}</li>)}</ol>}
        </li>;
      })}
    </ul>
    {editor && <CommandEditor key={`${editor.file}-${editor.yaml}`} file={editor.file} initial={editor.entry?.command ?? emptyCommand()} startInYaml={editor.yaml} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); notify('Команда сохранена'); void load(); }}/>}
  </section>;
}
