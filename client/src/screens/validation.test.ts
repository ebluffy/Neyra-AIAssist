import { describe, expect, it } from 'vitest';
import { emptyCommand, makeTrigger } from '../commands';
import { absoluteRoot, commandErrorFields } from './validation';

describe('permissions path precheck', () => {
  it.each(['/home/me/Docs', 'D:\\Work', 'D:/Work', '\\\\?\\D:\\Work', '\\\\?\\UNC\\server\\share', '\\\\server\\share'])('allows %s to reach backend validation', path => {
    expect(absoluteRoot(path)).toBe(true);
  });
  it.each(['Work', 'D:Work', '\\Work', '~/Work', '..\\Work', ''])('rejects relative path %s', path => {
    expect(absoluteRoot(path)).toBe(false);
  });
});

describe('command validation error fields', () => {
  const command = { ...emptyCommand(), triggers: [makeTrigger('phrase', 'hello'), makeTrigger('regex', '['), makeTrigger('hotkey', 'Ctrl+G')], params: [{ name: 'city' }, { name: 'city' }] };
  it.each([
    ['Некорректное регулярное выражение', ['trigger-2-value']],
    ['Регулярное выражение: до 120 символов', ['trigger-2-value']],
    ['Группа «site» не объявлена в params', ['trigger-2-value']],
    ['Фраза слишком короткая', ['trigger-1-value']],
    ['Хоткей должен включать Ctrl, Alt или Super', ['trigger-3-value']],
    ['Команда с таким именем уже есть', ['command-name']],
    ['Описание: до 200 символов, без управляющих символов', ['command-description']],
    ['Ответ: до 200 символов, без управляющих символов', ['command-reply']],
    ['Параметр «city»: уникальное имя до 24 символов', ['parameter-1-name', 'parameter-2-name']],
    ['Действие 1: параметр {site} не объявлен в params', ['action-1-tool']],
    ['Значение действия: до 500 символов, без управляющих символов', ['action-1-url']],
    ['Нет доступа к папке команд', []],
  ])('associates backend error %s with relevant controls', (message, fields) => {
    expect(commandErrorFields(message, command)).toEqual(fields);
  });
  it('does not replace Rust regex validation with JavaScript syntax', () => {
    const rustRegex = { ...command, triggers: [makeTrigger('regex', '(?i)hello'), makeTrigger('regex', '(?P<city>.+)')] };
    expect(commandErrorFields('Некорректное регулярное выражение', rustRegex)).toEqual(['trigger-1-value', 'trigger-2-value']);
  });
});
