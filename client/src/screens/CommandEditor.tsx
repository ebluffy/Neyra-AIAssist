import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type Action, type QuickCommand, TOOLS, emptyArguments, makeTrigger, minimumRisk, triggerKind, triggerValue } from '../commands';
import { formatError } from '../types';
import { commandErrorFields } from './validation';

export const YAML_TEMPLATE = `name: Моя команда
description: Что делает команда
triggers:
  - phrase: моя команда
actions:
  - tool: client.open_url
    arguments:
      url: https://example.com
`;

interface Props { file: string | null; initial: QuickCommand; startInYaml: boolean; onClose: () => void; onSaved: (file: string) => void }
interface YamlFailure { line: number | null; column: number | null; reason: string }

export function CommandEditor({ file, initial, startInYaml, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [command, setCommand] = useState<QuickCommand>(initial);
  const [yamlMode, setYamlMode] = useState(startInYaml);
  const [yaml, setYaml] = useState('');
  const [yamlFailure, setYamlFailure] = useState<YamlFailure>();
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadingYaml, setLoadingYaml] = useState(startInYaml);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const yamlField = useRef<HTMLTextAreaElement>(null);
  const nameError = saveAttempted && !command.name.trim() ? 'Укажите название команды.' : fieldErrors['command-name'];

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!node.open) node.showModal();
    return () => { if (node.open) node.close(); };
  }, []);
  useEffect(() => {
    if (yamlMode) { if (!loadingYaml) yamlField.current?.focus(); }
    else nameField.current?.focus();
  }, [yamlMode, loadingYaml]);
  useEffect(() => {
    if (!startInYaml) return;
    let alive = true;
    const load = file ? invoke<string>('command_get_yaml', { file }) : Promise.resolve(YAML_TEMPLATE);
    void load.then(text => { if (alive) { setYaml(text); setLoadingYaml(false); } }).catch(e => { if (alive) { setError(formatError(e)); setLoadingYaml(false); } });
    return () => { alive = false; };
  }, [file, startInYaml]);

  const openYaml = () => {
    if (!yaml) {
      setLoadingYaml(true);
      const load = file ? invoke<string>('command_get_yaml', { file }) : Promise.resolve(YAML_TEMPLATE);
      void load.then(text => { setYaml(text); setLoadingYaml(false); }).catch(e => { setError(formatError(e)); setLoadingYaml(false); });
    }
    setYamlMode(true);
  };
  const patch = (next: Partial<QuickCommand>) => { setCommand(c => ({ ...c, ...next })); setFieldErrors({}); setError(''); };
  const errorProps = (name: string) => ({ 'aria-invalid': !!fieldErrors[name], 'aria-describedby': fieldErrors[name] ? `${name}-error` : undefined });
  const fieldError = (name: string) => fieldErrors[name] ? <span className="field-error" id={`${name}-error`} role="alert">{fieldErrors[name]}</span> : null;
  const focusError = () => requestAnimationFrame(() => {
    const field = dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? dialog.current?.querySelector<HTMLElement>('#command-save-error');
    const details = field?.closest('details');
    if (details) details.open = true;
    field?.focus();
    field?.scrollIntoView({ block: 'center' });
  });
  const forcedRisk = minimumRisk(command) === 'confirm';
  const setAction = (index: number, action: Action) => patch({ actions: command.actions.map((a, i) => i === index ? action : a) });
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= command.actions.length) return;
    const actions = [...command.actions];
    [actions[index], actions[target]] = [actions[target], actions[index]];
    patch({ actions });
  };
  const withRisk = (next: QuickCommand): QuickCommand => minimumRisk(next) === 'confirm' ? { ...next, risk: 'confirm' } : next;

  const saveForm = async () => {
    setSaveAttempted(true);
    setError(''); setFieldErrors({});
    if (!command.name.trim()) { focusError(); return; }
    setSaving(true);
    try { onSaved(await invoke<string>('command_save', { file, command: withRisk({ ...command, name: command.name.trim() }) })); }
    catch (e) {
      const message = formatError(e);
      const fields = commandErrorFields(message, command);
      if (fields.length) setFieldErrors(Object.fromEntries(fields.map(name => [name, message])));
      else setError(message);
      focusError();
    }
    finally { setSaving(false); }
  };
  const saveYaml = async () => {
    setSaving(true); setError(''); setYamlFailure(undefined);
    try {
      const result = await invoke<{ ok: boolean; file?: string; error?: YamlFailure }>('command_save_yaml', { file, yaml });
      if (result.ok && result.file) onSaved(result.file);
      else { setYamlFailure(result.error); yamlField.current?.focus(); }
    } catch (e) { setError(formatError(e)); }
    finally { setSaving(false); }
  };

  return <dialog ref={dialog} className="editor" aria-labelledby="editor-title" onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose(); }}>
    <h2 id="editor-title">{file ? 'Изменить команду' : 'Новая команда'}</h2>
    <div className="actions" role="group" aria-label="Способ редактирования">
      <button type="button" aria-pressed={!yamlMode} disabled={saving} onClick={() => setYamlMode(false)}>Форма</button>
      <button type="button" aria-pressed={yamlMode} disabled={saving} onClick={openYaml}>YAML</button>
    </div>
    {error && <div className="error" id="command-save-error" tabIndex={-1} role="alert">{error}</div>}
    {yamlMode ? <>
      <label>Файл команды (YAML)<textarea ref={yamlField} name="command-yaml" autoComplete="off" className="yaml" spellCheck={false} rows={16} value={loadingYaml ? 'Загружаю…' : yaml} disabled={loadingYaml} aria-describedby={yamlFailure ? 'yaml-failure' : undefined} aria-invalid={!!yamlFailure} onChange={e => { setYaml(e.target.value); setYamlFailure(undefined); }}/></label>
      {yamlFailure && <p className="error" id="yaml-failure" role="alert">{yamlFailure.line ? `Строка ${yamlFailure.line}${yamlFailure.column ? `, столбец ${yamlFailure.column}` : ''}: ` : ''}{yamlFailure.reason}</p>}
      <p className="hint">Ваш текст и комментарии сохраняются как есть. Файл лежит в папке команд и подхватывается автоматически.</p>
    </> : <>
      <label>Название<input ref={nameField} name="command-name" type="text" autoComplete="off" value={command.name} maxLength={60} required aria-invalid={!!nameError} aria-describedby={nameError ? 'command-name-error' : undefined} onChange={e => patch({ name: e.target.value })}/>{nameError && <span className="field-error" id="command-name-error" role="alert">{nameError}</span>}</label>
      <label>Описание<input name="command-description" type="text" autoComplete="off" value={command.description ?? ''} maxLength={200} {...errorProps('command-description')} onChange={e => patch({ description: e.target.value })}/>{fieldError('command-description')}</label>
      <label className="check"><input name="command-enabled" type="checkbox" checked={command.enabled} onChange={e => patch({ enabled: e.target.checked })}/>Команда включена</label>
      <fieldset><legend>Когда запускать (до 4)</legend>
        {command.triggers.map((t, i) => <div className="row" key={i}>
          <label>Тип<select name={`trigger-${i + 1}-type`} autoComplete="off" value={triggerKind(t)} onChange={e => patch({ triggers: command.triggers.map((x, j) => j === i ? makeTrigger(e.target.value as 'phrase' | 'regex' | 'hotkey', '') : x) })}><option value="phrase">Фраза</option><option value="regex">Шаблон (regex)</option><option value="hotkey">Хоткей</option></select></label>
          <label>Значение<input name={`trigger-${i + 1}-value`} type="text" autoComplete="off" spellCheck={triggerKind(t) === 'phrase'} value={triggerValue(t)} maxLength={120} {...errorProps(`trigger-${i + 1}-value`)} placeholder={triggerKind(t) === 'hotkey' ? 'Ctrl+Alt+G…' : triggerKind(t) === 'regex' ? 'открой сайт (?P<site>[a-z.]+)…' : 'режим игры…'} onChange={e => patch({ triggers: command.triggers.map((x, j) => j === i ? makeTrigger(triggerKind(x), e.target.value) : x) })}/>{fieldError(`trigger-${i + 1}-value`)}</label>
          <button type="button" disabled={command.triggers.length <= 1} onClick={() => patch({ triggers: command.triggers.filter((_, j) => j !== i) })}>Убрать</button>
        </div>)}
        <button type="button" disabled={command.triggers.length >= 4} onClick={() => patch({ triggers: [...command.triggers, makeTrigger('phrase', '')] })}>Добавить триггер</button>
      </fieldset>
      <details><summary>Параметры ({command.params?.length ?? 0})</summary>
        <p className="hint">В действиях можно писать {'{имя}'}. Значение берётся из группы шаблона или из значения по умолчанию. Итог всё равно проверяет политика ПК.</p>
        {(command.params ?? []).map((p, i) => <div className="row" key={i}>
          <label>Имя (a–z, 0–9, _)<input name={`parameter-${i + 1}-name`} type="text" autoComplete="off" spellCheck={false} value={p.name} maxLength={24} {...errorProps(`parameter-${i + 1}-name`)} onChange={e => patch({ params: (command.params ?? []).map((x, j) => j === i ? { ...x, name: e.target.value } : x) })}/>{fieldError(`parameter-${i + 1}-name`)}</label>
          <label>По умолчанию<input name={`parameter-${i + 1}-default`} type="text" autoComplete="off" spellCheck={false} value={p.default ?? ''} maxLength={200} {...errorProps(`parameter-${i + 1}-default`)} onChange={e => patch({ params: (command.params ?? []).map((x, j) => j === i ? { ...x, default: e.target.value || null } : x) })}/>{fieldError(`parameter-${i + 1}-default`)}</label>
          <button type="button" onClick={() => patch({ params: (command.params ?? []).filter((_, j) => j !== i) })}>Убрать</button>
        </div>)}
        <button type="button" disabled={(command.params?.length ?? 0) >= 4} onClick={() => patch({ params: [...(command.params ?? []), { name: '', default: null }] })}>Добавить параметр</button>
      </details>
      <fieldset><legend>Что делать по порядку (до 10)</legend>
        {command.actions.map((a, i) => <div className="step" key={i}>
          <strong>Шаг {i + 1}</strong>
          <label>Действие<select name={`action-${i + 1}-tool`} autoComplete="off" value={a.tool} {...errorProps(`action-${i + 1}-tool`)} onChange={e => setAction(i, { tool: e.target.value, arguments: emptyArguments(e.target.value) })}>{Object.entries(TOOLS).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}</select>{fieldError(`action-${i + 1}-tool`)}</label>
          {(TOOLS[a.tool]?.keys ?? []).map(k => <label key={k.name}>{k.label}<input name={`action-${i + 1}-${k.name}`} type={k.name === 'url' ? 'url' : 'text'} inputMode={k.name === 'url' ? 'url' : 'text'} autoComplete="off" spellCheck={k.name === 'query'} value={a.arguments[k.name] ?? ''} maxLength={500} {...errorProps(`action-${i + 1}-${k.name}`)} placeholder={`${k.hint}…`} onChange={e => setAction(i, { ...a, arguments: { ...a.arguments, [k.name]: e.target.value } })}/>{fieldError(`action-${i + 1}-${k.name}`)}</label>)}
          <div className="actions">
            <button type="button" aria-label={`Шаг ${i + 1} выше`} disabled={i === 0} onClick={() => move(i, -1)}>Выше</button>
            <button type="button" aria-label={`Шаг ${i + 1} ниже`} disabled={i === command.actions.length - 1} onClick={() => move(i, 1)}>Ниже</button>
            <button type="button" disabled={command.actions.length <= 1} onClick={() => patch({ actions: command.actions.filter((_, j) => j !== i) })}>Убрать шаг</button>
          </div>
        </div>)}
        <button type="button" disabled={command.actions.length >= 10} onClick={() => patch({ actions: [...command.actions, { tool: 'client.open_url', arguments: emptyArguments('client.open_url') }] })}>Добавить шаг</button>
      </fieldset>
      <label>Если шаг не удался<select name="command-on-error" autoComplete="off" value={command.on_error} onChange={e => patch({ on_error: e.target.value as 'stop' | 'continue' })}><option value="stop">Остановить команду</option><option value="continue">Продолжить со следующего шага</option></select></label>
      <label className="check"><input name="command-confirm" type="checkbox" checked={command.confirm} onChange={e => patch({ confirm: e.target.checked })}/>Спрашивать перед запуском всей команды</label>
      <label>Уровень риска<select name="command-risk" autoComplete="off" value={forcedRisk ? 'confirm' : command.risk} disabled={forcedRisk} aria-describedby={forcedRisk ? 'command-risk-reason' : undefined} onChange={e => patch({ risk: e.target.value as 'safe' | 'confirm' })}><option value="safe">Безопасная</option><option value="confirm">С подтверждением</option></select></label>
      {forcedRisk && <p className="hint" id="command-risk-reason">Закрытие окон всегда требует подтверждения.</p>}
      <label>Ответ после выполнения<input name="command-reply" type="text" autoComplete="off" value={command.reply ?? ''} maxLength={200} {...errorProps('command-reply')} onChange={e => patch({ reply: e.target.value })}/>{fieldError('command-reply')}</label>
      <label className="check"><input name="command-speak" type="checkbox" checked={command.speak} onChange={e => patch({ speak: e.target.checked })}/>Озвучить ответ (нужно подключение к серверу)</label>
    </>}
    <div className="actions dialog-actions">
      <button type="button" onClick={onClose} disabled={saving}>Отмена</button>
      <button type="button" className="primary" disabled={saving || loadingYaml} onClick={() => void (yamlMode ? saveYaml() : saveForm())}>{saving ? 'Сохраняю…' : 'Сохранить'}</button>
    </div>
  </dialog>;
}
