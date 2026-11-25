import { describe, expect, it } from 'vitest';
import { describeRun, emptyArguments, emptyCommand, locationText, makeTrigger, minimumRisk, recoveryText, summarizeActions, summarizeTriggers, triggerKind, triggerValue } from './commands';

describe('quick command helpers', () => {
  it('starts from a valid, safe, enabled command', () => {
    const c = emptyCommand();
    expect(c.schema_version).toBe(1); expect(c.enabled).toBe(true); expect(c.risk).toBe('safe'); expect(c.confirm).toBe(false); expect(c.actions).toHaveLength(1);
  });
  it('round-trips trigger kinds', () => {
    for (const kind of ['phrase', 'regex', 'hotkey'] as const) { const t = makeTrigger(kind, 'x'); expect(triggerKind(t)).toBe(kind); expect(triggerValue(t)).toBe('x'); expect(Object.keys(t)).toEqual([kind]); }
  });
  it('requires confirm risk for closing windows', () => {
    const c = emptyCommand(); expect(minimumRisk(c)).toBe('safe');
    c.actions.push({ tool: 'client.close_window', arguments: { window: '0x1' } }); expect(minimumRisk(c)).toBe('confirm');
  });
  it('creates only the argument keys of a tool', () => {
    expect(emptyArguments('client.open_app')).toEqual({ path: '' }); expect(emptyArguments('client.list_apps')).toEqual({}); expect(emptyArguments('client.shell_exec')).toEqual({});
  });
  it('describes commands in short Russian text', () => {
    const c = emptyCommand(); c.name = 'Игра'; c.triggers = [makeTrigger('phrase', 'режим игры'), makeTrigger('hotkey', 'Ctrl+Alt+G')];
    expect(summarizeTriggers(c)).toBe('Фраза: режим игры · Хоткей: Ctrl+Alt+G'); expect(summarizeActions(c)).toBe('Открыть ссылку');
    expect(describeRun({ name: 'Игра', state: 'step', step: 2, total: 3, tool: 'client.media' })).toBe('«Игра»: шаг 2 из 3 · Медиа');
    expect(describeRun({ name: 'Игра', state: 'failed', message: 'Шаг 1 из 2: Доступ к ПК выключен' })).toContain('Доступ к ПК выключен');
    expect(describeRun({ name: 'Игра', state: 'finished', reply: 'Запускаю' })).toBe('«Игра»: готово · Запускаю');
  });
  it('points at file and line for broken files', () => {
    expect(locationText({ file: 'a.yaml', line: 4, column: 2, reason: 'x', kept_previous: true })).toBe('a.yaml, строка 4, столбец 2');
    expect(locationText({ file: 'a.yaml', line: null, column: null, reason: 'x', kept_previous: false })).toBe('a.yaml');
  });
  it('explains recovered files without technical jargon', () => {
    const text = recoveryText({ file: 'settings/app.json', reason: 'corrupt', restored: 'backup', quarantined: 'app.json.corrupt-1' });
    expect(text).toContain('повреждён'); expect(text).toContain('последняя рабочая копия'); expect(text).toContain('app.json.corrupt-1');
    expect(recoveryText({ file: 'x', reason: 'unsupported', restored: 'defaults', quarantined: null })).toContain('более новой версией');
  });
});
