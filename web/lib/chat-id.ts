/** Идентификатор диалога для STM ядра: один на вкладку, переживает перезагрузку. */
export interface ChatIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Окно, у которого можно прочитать и записать window.name. */
export interface TabNameWindow {
  name: string;
}

export const CHAT_ID_KEY = 'neyra.chat_id';
export const TAB_KEY = 'neyra.tab';

/**
 * Ключ вкладки. window.name переживает перезагрузку, но не копируется в окно,
 * открытое через window.open, — в отличие от sessionStorage. Поэтому новая
 * вкладка получает свой тред, а reload — прежний.
 */
export function resolveTabKey(win: TabNameWindow | null, makeId: () => string = () => crypto.randomUUID()): string {
  if (!win) return 'ssr';
  const name = String(win.name || '').trim();
  if (name.startsWith(`${TAB_KEY}:`)) {
    const saved = name.slice(TAB_KEY.length + 1).trim();
    if (saved) return saved;
  }
  const id = makeId();
  try {
    win.name = `${TAB_KEY}:${id}`;
  } catch {
    // Some embedded contexts lock window.name; fall back to the per-document id.
  }
  return id;
}

export function resolveChatId(
  storage: ChatIdStorage | null,
  tabKey: string,
  makeId: () => string = () => crypto.randomUUID(),
): string {
  const key = `${CHAT_ID_KEY}:${tabKey}`;
  const saved = storage ? storage.getItem(key) : null;
  if (saved && saved.trim()) return saved;
  const id = makeId();
  storage?.setItem(key, id);
  return id;
}
