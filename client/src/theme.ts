export const THEMES = [
  { id: 'neyra', label: 'Нейра' },
  { id: 'dark', label: 'Тёмная' },
  { id: 'light', label: 'Светлая' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export function themeId(value: string | undefined): ThemeId {
  return THEMES.some(theme => theme.id === value) ? (value as ThemeId) : 'neyra';
}

export const SHEETS = [
  { id: 'voice', label: 'Голос' },
  { id: 'commands', label: 'Быстрые команды' },
  { id: 'permissions', label: 'Доступ к ПК' },
  { id: 'server', label: 'Сервер и устройства' },
  { id: 'character', label: 'Персонаж' },
  { id: 'settings', label: 'Настройки' },
  { id: 'status', label: 'Состояние и модули' },
  { id: 'updates', label: 'Обновления' },
  { id: 'about', label: 'О программе' },
] as const;

export type SheetId = (typeof SHEETS)[number]['id'];
