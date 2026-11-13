export interface Guild {
  id: string; name: string | null; icon_url: string | null; description?: string | null;
  counts?: {channels: number; members: number}; channel_count?: number; member_count?: number;
}
export interface Member {
  guild_id: string; discord_id: string; person_id: string | null; username: string | null;
  display_name: string | null; is_bot: boolean | number;
}
export interface Channel {id: string; name: string | null; type: string | null; parent_id: string | null}
export interface GuildDetail {guild: Guild; channels: Channel[]; members: Member[]; counts: {channels: number; members: number}}
export interface Catalog<T> {items: T[]; available?: boolean; total?: number; next_cursor?: number | null}
export interface Message {
  id: number; ts: string; role: string; person_id: string | null; display_name: string | null;
  discord_id: string | null; discord_username: string | null; channel_id: string | null; text: string;
}
export interface Stats {
  available: boolean; messages: number; turns: number; first_contact: string | null; last_contact: string | null;
  channels: {channel_id: string | null; messages: number}[]; days: {date: string; messages: number}[];
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
