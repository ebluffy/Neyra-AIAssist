// Прокси админки к каталогу Discord в ядре: только разрешённые параметры,
// числа в безопасных границах, даты — ISO. Секретов в ответах нет.

import { coreGet, type CoreResult } from './core-admin';
import { jsonError } from './admin-http';

export type ParamKind = 'int' | 'text' | 'date';

export interface ParamSpec {
  key: string;
  kind: ParamKind;
  min?: number;
  max?: number;
  fallback?: number;
  maxLength?: number;
}

export type QueryResult =
  | { ok: true; query: string }
  | { ok: false; message: string };

function intValue(raw: string, spec: ParamSpec): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  const min = spec.min ?? 0;
  const max = spec.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, min), max);
}

function isoValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// Неизвестные ключи игнорируются: маршрут не должен превращаться в открытый прокси.
export function buildCoreQuery(searchParams: URLSearchParams, specs: readonly ParamSpec[]): QueryResult {
  const query = new URLSearchParams();
  for (const spec of specs) {
    const raw = searchParams.get(spec.key);
    if (raw === null) continue;
    const value = raw.trim();
    if (!value) continue;

    if (spec.kind === 'int') {
      const parsed = intValue(value, spec);
      if (parsed === null) {
        return { ok: false, message: `${spec.key}: ожидается целое число.` };
      }
      query.set(spec.key, String(parsed));
      continue;
    }

    if (spec.kind === 'date') {
      const parsed = isoValue(value);
      if (parsed === null) {
        return { ok: false, message: `${spec.key}: ожидается дата ISO.` };
      }
      query.set(spec.key, parsed);
      continue;
    }

    const max = spec.maxLength ?? 200;
    query.set(spec.key, value.slice(0, max));
  }
  const text = query.toString();
  return { ok: true, query: text ? `?${text}` : '' };
}

export const GUILD_LIST_SPEC: readonly ParamSpec[] = [
  { key: 'limit', kind: 'int', min: 1, max: 200 },
  { key: 'offset', kind: 'int', min: 0, max: 100000 },
];

export const GUILD_DETAIL_SPEC: readonly ParamSpec[] = [
  { key: 'member_limit', kind: 'int', min: 1, max: 500 },
];

export const MEMBER_SPEC: readonly ParamSpec[] = [
  { key: 'guild_id', kind: 'text', maxLength: 120 },
  { key: 'q', kind: 'text', maxLength: 120 },
  { key: 'limit', kind: 'int', min: 1, max: 200 },
  { key: 'offset', kind: 'int', min: 0, max: 100000 },
];

export const USER_STATS_SPEC: readonly ParamSpec[] = [
  { key: 'days', kind: 'int', min: 1, max: 365 },
];

export const MESSAGE_SPEC: readonly ParamSpec[] = [
  { key: 'guild_id', kind: 'text', maxLength: 120 },
  { key: 'channel_id', kind: 'text', maxLength: 120 },
  { key: 'person_id', kind: 'text', maxLength: 120 },
  { key: 'from', kind: 'date' },
  { key: 'to', kind: 'date' },
  { key: 'q', kind: 'text', maxLength: 200 },
  { key: 'cursor', kind: 'int', min: 0, max: Number.MAX_SAFE_INTEGER },
  { key: 'limit', kind: 'int', min: 1, max: 200 },
];

export interface DiscordGuildRow {
  id: string;
  name: string | null;
  icon_url: string | null;
  description: string | null;
  joined_at: string | null;
  updated_at: string;
  channel_count: number;
  member_count: number;
}

export interface DiscordGuildPage {
  items: DiscordGuildRow[];
  total: number;
  limit: number;
  offset: number;
  available: boolean;
}

export interface DiscordChannelRow {
  id: string;
  guild_id: string;
  name: string | null;
  type: string | null;
  parent_id: string | null;
  updated_at: string;
}

export interface DiscordMemberRow {
  guild_id: string;
  discord_id: string;
  person_id: string | null;
  username: string | null;
  display_name: string | null;
  is_bot: number;
  first_seen: string;
  last_seen: string;
}

export interface DiscordGuildDetail {
  guild: Omit<DiscordGuildRow, 'channel_count' | 'member_count'>;
  channels: DiscordChannelRow[];
  members: DiscordMemberRow[];
  counts: { channels: number; members: number };
}

export interface DiscordMemberPage {
  items: DiscordMemberRow[];
  total: number;
  limit: number;
  offset: number;
  available: boolean;
}

export interface DiscordMessageRow {
  id: number;
  ts: string;
  role: string;
  person_id: string | null;
  display_name: string | null;
  discord_id: string | null;
  discord_username: string | null;
  channel_id: string | null;
  guild_id: string | null;
  platform: string | null;
  source: string | null;
  text: string;
  turn_id: string | null;
  native_message_id: string | null;
  native_created_at: string | null;
}

export interface DiscordMessagePage {
  items: DiscordMessageRow[];
  total: number;
  limit: number;
  next_cursor: number | null;
  available: boolean;
}

export interface DiscordPersonStats {
  person_id: string;
  messages: number;
  turns: number;
  channels: Array<{ channel_id: string | null; guild_id: string | null; messages: number; turns: number }>;
  first_contact: string | null;
  last_contact: string | null;
  days: Array<{ date: string; messages: number }>;
  available: boolean;
}

interface PeopleResponse {
  people?: Array<{
    id?: string;
    discord_ids?: string[];
    accounts?: Array<{ platform?: string; platform_user_id?: string; person_id?: string }>;
  }>;
}

// Каталог серверов не пишет связь с памятью: сопоставляем Discord ID с person_id
// по аккаунтам памяти, иначе карточка человека не может показать статистику.
export async function discordPersonMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const result = await coreGet<PeopleResponse>('/v1/memory/people?limit=500', { timeoutMs: 5000 });
  if (result.state !== 'ok' || !result.data) return map;
  for (const person of result.data.people ?? []) {
    const personId = person.id;
    if (!personId) continue;
    for (const discordId of person.discord_ids ?? []) {
      if (discordId) map.set(discordId, personId);
    }
    for (const account of person.accounts ?? []) {
      if (account.platform === 'discord' && account.platform_user_id) {
        map.set(account.platform_user_id, account.person_id || personId);
      }
    }
  }
  return map;
}

export function fillDiscordPersonIds(
  members: DiscordMemberRow[],
  map: Map<string, string>,
): DiscordMemberRow[] {
  return members.map((member) => (
    member.person_id || !map.has(member.discord_id)
      ? member
      : { ...member, person_id: map.get(member.discord_id) ?? null }
  ));
}

export function readDiscordGuilds(query: string): Promise<CoreResult<DiscordGuildPage>> {
  return coreGet<DiscordGuildPage>(`/v1/admin/discord/guilds${query}`, { timeoutMs: 5000 });
}

export function readDiscordGuild(guildId: string, query: string): Promise<CoreResult<DiscordGuildDetail>> {
  return coreGet<DiscordGuildDetail>(
    `/v1/admin/discord/guilds/${encodeURIComponent(guildId)}${query}`,
    { timeoutMs: 5000 },
  );
}

export function readDiscordMembers(query: string): Promise<CoreResult<DiscordMemberPage>> {
  return coreGet<DiscordMemberPage>(`/v1/admin/discord/members${query}`, { timeoutMs: 5000 });
}

export function readDiscordUserStats(personId: string, query: string): Promise<CoreResult<DiscordPersonStats>> {
  return coreGet<DiscordPersonStats>(
    `/v1/admin/discord/users/${encodeURIComponent(personId)}/stats${query}`,
    { timeoutMs: 5000 },
  );
}

export function readDiscordMessages(query: string): Promise<CoreResult<DiscordMessagePage>> {
  return coreGet<DiscordMessagePage>(`/v1/admin/discord/messages${query}`, { timeoutMs: 5000 });
}

// Ошибка ядра → статус сайта: 400/404 сохраняем, недоступность — 502/503.
export function discordCoreStatus(result: CoreResult<unknown>): number {
  if (result.status === 400 || result.status === 404) return result.status;
  if (result.state === 'unconfigured') return 503;
  return 502;
}

export function discordFailure(result: CoreResult<unknown>, fallback: string): Response {
  const code = result.status === 404
    ? 'not_found'
    : result.state === 'unconfigured'
      ? 'core_unconfigured'
      : 'core_unavailable';
  return jsonError(discordCoreStatus(result), code, result.message ?? fallback);
}
