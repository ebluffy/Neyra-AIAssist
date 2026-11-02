export interface Trigger { phrase?: string; regex?: string; hotkey?: string }
export interface Param { name: string; default?: string | null; description?: string }
export interface Action { tool: string; arguments: Record<string, string> }
export interface QuickCommand {
  schema_version: number; name: string; description?: string; enabled: boolean;
  triggers: Trigger[]; params?: Param[]; actions: Action[];
  on_error: 'stop' | 'continue'; confirm: boolean; risk: 'safe' | 'confirm'; reply?: string; speak: boolean;
}
export interface HotkeyState { hotkey: string; registered: boolean }
export interface CommandEntry { file: string; command: QuickCommand; hotkeys: HotkeyState[] }
export interface CommandLoadError { file: string; line: number | null; column: number | null; reason: string; kept_previous: boolean }
export interface CommandsView { commands: CommandEntry[]; errors: CommandLoadError[]; hotkeys_available: boolean; folder: string; max_commands: number }
export interface Preview { step: number; tool: string; verdict: 'safe' | 'confirm' | 'denied' | 'unavailable'; message: string }
export interface RunEvent { run_id?: string; name: string; state: 'started' | 'step' | 'finished' | 'failed' | 'cancelled'; step?: number; total?: number; tool?: string; message?: string; reply?: string; source?: string }
export interface DraftEvent { draft_id: string; command: QuickCommand; exists: boolean }
export interface ImportItem { name: string; status: 'new' | 'same' | 'conflict' | 'invalid'; error: string | null }
export interface ImportPreview {
  cancelled: boolean; items?: ImportItem[];
  settings?: { theme: string; graphics_mode: string; audit_days: number };
  permissions?: { allow_web: boolean; system: boolean; web_domains: string[]; apps: string[]; blocked?: string[] };
}

export const TOOLS: Record<string, { label: string; keys: { name: string; label: string; hint: string }[]; closes?: boolean }> = {
  'client.open_app': { label: 'Открыть программу', keys: [{ name: 'path', label: 'Путь к программе', hint: '/usr/bin/steam' }] },
  'client.open_url': { label: 'Открыть ссылку', keys: [{ name: 'url', label: 'Ссылка', hint: 'https://example.com' }] },
  'client.search_web': { label: 'Поиск в браузере', keys: [{ name: 'query', label: 'Запрос', hint: 'погода' }] },
  'client.list_apps': { label: 'Список программ', keys: [] },
  'client.list_windows': { label: 'Список окон', keys: [] },
  'client.focus_window': { label: 'Перейти к окну', keys: [{ name: 'window', label: 'ID окна', hint: '0x03a00007' }] },
  'client.close_window': { label: 'Закрыть окно', closes: true, keys: [{ name: 'window', label: 'ID окна', hint: '0x03a00007' }] },
  'client.media': { label: 'Медиа', keys: [{ name: 'action', label: 'Действие', hint: 'play_pause, next, previous' }] },
  'client.volume': { label: 'Громкость', keys: [{ name: 'action', label: 'Действие', hint: 'up, down, mute' }] },
};

export function emptyCommand(): QuickCommand {
  return { schema_version: 1, name: '', description: '', enabled: true, triggers: [{ phrase: '' }], params: [], actions: [{ tool: 'client.open_url', arguments: { url: '' } }], on_error: 'stop', confirm: false, risk: 'safe', reply: '', speak: false };
}

export function triggerKind(t: Trigger): 'phrase' | 'regex' | 'hotkey' { return t.regex !== undefined ? 'regex' : t.hotkey !== undefined ? 'hotkey' : 'phrase'; }
export function triggerValue(t: Trigger): string { return t.phrase ?? t.regex ?? t.hotkey ?? ''; }
export function makeTrigger(kind: 'phrase' | 'regex' | 'hotkey', value: string): Trigger { return kind === 'regex' ? { regex: value } : kind === 'hotkey' ? { hotkey: value } : { phrase: value }; }

export function emptyArguments(tool: string): Record<string, string> { return Object.fromEntries((TOOLS[tool]?.keys ?? []).map(k => [k.name, ''])); }

export function minimumRisk(command: QuickCommand): 'safe' | 'confirm' { return command.actions.some(a => TOOLS[a.tool]?.closes) ? 'confirm' : 'safe'; }

export function summarizeTriggers(command: QuickCommand): string {
  return command.triggers.map(t => { const kind = triggerKind(t); return `${kind === 'phrase' ? 'Фраза' : kind === 'regex' ? 'Шаблон' : 'Хоткей'}: ${triggerValue(t)}`; }).join(' · ');
}
export function summarizeActions(command: QuickCommand): string { return command.actions.map(a => TOOLS[a.tool]?.label ?? a.tool).join(' → '); }

export function describeRun(e: RunEvent): string {
  if (e.state === 'started') return `«${e.name}»: запуск…`;
  if (e.state === 'step') return `«${e.name}»: шаг ${e.step} из ${e.total}${e.tool ? ` · ${TOOLS[e.tool]?.label ?? e.tool}` : ''}`;
  if (e.state === 'finished') return `«${e.name}»: готово${e.reply ? ` · ${e.reply}` : ''}`;
  if (e.state === 'cancelled') return `«${e.name}»: остановлено${e.message ? ` · ${e.message}` : ''}`;
  return `«${e.name}»: ${e.message ?? 'не выполнено'}`;
}

export const VERDICT_LABEL: Record<Preview['verdict'], string> = { safe: 'Без вопросов', confirm: 'С подтверждением', denied: 'Запрещено', unavailable: 'Недоступно' };

export function locationText(error: CommandLoadError): string { return error.line ? `${error.file}, строка ${error.line}${error.column ? `, столбец ${error.column}` : ''}` : error.file; }

export function recoveryText(r: { file: string; reason: string; restored: string; quarantined: string | null }): string {
  const why = r.reason === 'unsupported' ? 'создан более новой версией приложения' : r.reason === 'too_large' ? 'слишком большой' : 'повреждён';
  const what = r.restored === 'backup' ? 'восстановлена последняя рабочая копия' : 'использованы значения по умолчанию';
  return `${r.file}: файл ${why}; ${what}.${r.quarantined ? ` Исходный файл сохранён как ${r.quarantined}.` : ''}`;
}
