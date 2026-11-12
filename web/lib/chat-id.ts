/** Идентификатор диалога для STM ядра: один на весь видимый чат, переживает перезагрузку. */
export interface ChatIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CHAT_ID_KEY = 'neyra.chat_id';

export function resolveChatId(storage: ChatIdStorage | null, makeId: () => string = () => crypto.randomUUID()): string {
  const saved = storage ? storage.getItem(CHAT_ID_KEY) : null;
  if (saved && saved.trim()) return saved;
  const id = makeId();
  storage?.setItem(CHAT_ID_KEY, id);
  return id;
}
