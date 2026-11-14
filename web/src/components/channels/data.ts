export interface Guild {
  id: string; name: string | null; icon_url: string | null; description?: string | null;
  counts?: {channels: number; members: number}; channel_count?: number; member_count?: number;
}
export interface Member {
  guild_id: string; discord_id: string; person_id: string | null; username: string | null;
  display_name: string | null; is_bot: boolean | number;
}
export interface Channel {id: string; name: string | null; type: string | null; parent_id: string | null}
export interface GuildDetail {guild: Guild; channels: Channel[]; members: Member[]; counts: {channels: number; members: number}; available?: boolean; message?: string}
export interface Catalog<T> {items: T[]; available?: boolean; total?: number; next_cursor?: number | null; message?: string}
export interface Message {
  id: number;
  ts: string;
  role: string;
  person_id: string | null;
  display_name: string | null;
  discord_id: string | null;
  discord_username: string | null;
  channel_id: string | null;
  guild_id?: string | null;
  platform?: string | null;
  text: string;
  turn_id?: string | null;
}
export interface Stats {
  available: boolean; messages: number; turns: number; first_contact: string | null; last_contact: string | null;
  channels: {channel_id: string | null; messages: number}[]; days: {date: string; messages: number}[];
}
export interface ActivityChannel {
  channel_id: string;
  messages: number;
  last_ts: string | null;
}
export interface ActivityPerson {
  person_id: string;
  messages: number;
  last_ts: string | null;
}
export interface ActivityData {
  available: boolean;
  channels: ActivityChannel[];
  people: ActivityPerson[];
  scanned: number;
  truncated: boolean;
}

export const api = '/api/admin/discord';

export async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(url, {signal, cache:'no-store'}); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('Нет соединения с сервером.'); }
  let body;
  try { body = await response.json(); }
  catch { throw new Error('Сервер вернул некорректный ответ.'); }
  if (!response.ok || body.ok === false) throw new Error(body.message || `Не удалось загрузить данные (${response.status}).`);
  return body.data ?? body;
}

export function moscowDate(value?: string | null) {
  if (!value) return 'Нет данных';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Дата неизвестна';
  return new Intl.DateTimeFormat('ru-RU', {timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
}

export function periodStart(period: string) {
  if (period === 'all') return undefined;
  const now = new Date();
  // Today starts at midnight Moscow, independently of the browser's timezone.
  const shifted = new Date(now.getTime() + 3 * 3600_000);
  const midnight = Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate()) - 3 * 3600_000;
  return new Date(period === 'today' ? midnight : now.getTime() - Number(period)*86400_000).toISOString();
}

export const channelLabel = (id: string | null) => !id ? 'Канал неизвестен' : id.startsWith('web:') ? 'веб-чат' : id;

// Ядро пишет в текст пользователя служебный префикс автора. В истории он лишний.
const AUTHOR_PREFIX = /^\s*\[author_id:\s*[^\]]*\]\s*/i;
const USER_PREFIX = /^\s*\[Пользователь[^\]]*\]:\s*/i;

export function cleanMessageText(text: string): string {
  let value = text.replace(AUTHOR_PREFIX, '');
  value = value.replace(USER_PREFIX, '');
  return value.trim() ? value : text;
}

export interface TurnBlock {
  turn_id: string;
  userMessages: Message[];
  assistantMessages: Message[];
  allMessages: Message[];
  latestTs: string;
}

/**
 * Группировка сообщений по turn_id для режима «Вся история».
 * Исключает технические сообщения model_trace.
 * Содержит блок: сообщение(я) пользователя -> ответ(ы) Нейры.
 * Если ответа нет, assistantMessages остаётся пустым (метка «Ответа нет»).
 */
export function groupMessagesByTurn(messages: Message[]): TurnBlock[] {
  const valid = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const turns = new Map<string, TurnBlock>();
  let fallbackIndex = 0;

  for (const msg of valid) {
    const key = msg.turn_id || `turn-fallback-${msg.id || ++fallbackIndex}`;
    let turn = turns.get(key);
    if (!turn) {
      turn = {
        turn_id: key,
        userMessages: [],
        assistantMessages: [],
        allMessages: [],
        latestTs: msg.ts,
      };
      turns.set(key, turn);
    }
    turn.allMessages.push(msg);
    if (msg.role === 'user') {
      turn.userMessages.push(msg);
    } else if (msg.role === 'assistant') {
      turn.assistantMessages.push(msg);
    }
    if (new Date(msg.ts).getTime() > new Date(turn.latestTs).getTime()) {
      turn.latestTs = msg.ts;
    }
  }

  for (const turn of turns.values()) {
    turn.allMessages.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime() || a.id - b.id);
    turn.userMessages.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime() || a.id - b.id);
    turn.assistantMessages.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime() || a.id - b.id);
  }

  return Array.from(turns.values()).sort((a, b) => {
    const timeA = a.allMessages[0] ? new Date(a.allMessages[0].ts).getTime() : 0;
    const timeB = b.allMessages[0] ? new Date(b.allMessages[0].ts).getTime() : 0;
    return timeA - timeB;
  });
}
