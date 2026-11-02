import { type QuickCommand, triggerKind } from '../commands';
import { absolutePath } from '../types';

export function absoluteRoot(value: string): boolean {
  // Rust validates UNC and Windows namespace paths, including \\?\, on save.
  return absolutePath(value) || value.startsWith('\\\\');
}

export function commandErrorFields(message: string, command: QuickCommand): string[] {
  if (/^(Укажите имя|Имя:|Команда с таким именем)/.test(message)) return ['command-name'];
  if (message.startsWith('Описание:')) return ['command-description'];
  if (message.startsWith('Ответ:')) return ['command-reply'];
  const kind = /регулярное выражение/i.test(message) || message.startsWith('Группа «') ? 'regex'
    : message.startsWith('Фраза') ? 'phrase' : message.startsWith('Хоткей') ? 'hotkey' : undefined;
  if (kind) return command.triggers.flatMap((trigger, i) => triggerKind(trigger) === kind ? [`trigger-${i + 1}-value`] : []);
  const parameter = message.match(/^Параметр «([^»]*)»/);
  if (parameter) return (command.params ?? []).flatMap((param, i) => param.name === parameter[1] ? [`parameter-${i + 1}-name`] : []);
  if (message.startsWith('Значение по умолчанию:')) return (command.params ?? []).map((_, i) => `parameter-${i + 1}-default`);
  const step = message.match(/^Действие (\d+):/);
  if (step) return [`action-${step[1]}-tool`];
  if (message.startsWith('Значение действия:')) return command.actions.flatMap((action, i) => Object.keys(action.arguments).map(key => `action-${i + 1}-${key}`));
  return [];
}
