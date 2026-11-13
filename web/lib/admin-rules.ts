// Чистые правила админки: разбор запросов, защита от опасных действий.
// Без БД и сети — чтобы проверялись юнит-тестами.

export const USERS_PAGE_SIZE = 20;
export const INVITES_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export type UserRoleFilter = 'all' | 'admin' | 'user';
export type UserStatusFilter = 'all' | 'active' | 'banned';

export interface UserListQuery {
  q: string;
  page: number;
  pageSize: number;
  role: UserRoleFilter;
  status: UserStatusFilter;
}

export interface InviteListQuery {
  page: number;
  pageSize: number;
  state: InviteStateFilter;
}

export type InviteStateFilter = 'all' | 'active' | 'used' | 'expired' | 'revoked';

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: RawParams, name: string): string {
  if (params instanceof URLSearchParams) return (params.get(name) ?? '').trim();
  const value = params[name];
  if (Array.isArray(value)) return (value[0] ?? '').trim();
  return (value ?? '').trim();
}

function positiveInt(value: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

// Поиск идёт по email и имени. Символы шаблона LIKE не нужны в email/имени,
// поэтому вырезаем их: иначе «%» превращает поиск в «все записи».
export function normalizeSearch(value: string): string {
  return value.replace(/[%_\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function parseUserListQuery(params: RawParams): UserListQuery {
  const role = read(params, 'role');
  const status = read(params, 'status');
  return {
    q: normalizeSearch(read(params, 'q')),
    page: positiveInt(read(params, 'page'), 1, 100000),
    pageSize: positiveInt(read(params, 'pageSize'), USERS_PAGE_SIZE, MAX_PAGE_SIZE),
    role: role === 'admin' || role === 'user' ? role : 'all',
    status: status === 'banned' || status === 'active' ? status : 'all',
  };
}

export function parseInviteListQuery(params: RawParams): InviteListQuery {
  const state = read(params, 'state');
  const allowed: InviteStateFilter[] = ['active', 'used', 'expired', 'revoked'];
  return {
    page: positiveInt(read(params, 'page'), 1, 100000),
    pageSize: positiveInt(read(params, 'pageSize'), INVITES_PAGE_SIZE, MAX_PAGE_SIZE),
    state: allowed.includes(state as InviteStateFilter) ? (state as InviteStateFilter) : 'all',
  };
}

export function pageOffset(page: number, pageSize: number): number {
  return Math.max(0, page - 1) * pageSize;
}

export function pageCount(total: number, pageSize: number): number {
  if (total <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export type AdminActionError = 'self' | 'last-admin' | 'not-found';

// Снять роль у себя нельзя: админ может случайно потерять доступ.
// Последнего администратора нельзя ни понизить, ни удалить — иначе управлять сайтом некому.
export function checkRoleChange(
  actorId: string,
  target: { id: string; role: string },
  nextRole: 'admin' | 'user',
  adminCount: number,
): AdminActionError | null {
  if (target.id === actorId && nextRole !== 'admin') return 'self';
  if (target.role === 'admin' && nextRole !== 'admin' && adminCount <= 1) return 'last-admin';
  return null;
}

export function checkDelete(
  actorId: string,
  target: { id: string; role: string },
  adminCount: number,
): AdminActionError | null {
  if (target.id === actorId) return 'self';
  if (target.role === 'admin' && adminCount <= 1) return 'last-admin';
  return null;
}

// TTL инвайта: от часа до 30 суток.
export const MIN_INVITE_TTL_HOURS = 1;
export const MAX_INVITE_TTL_HOURS = 720;

export function normalizeInviteTtl(value: unknown): number | null {
  const hours = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(hours) || hours < MIN_INVITE_TTL_HOURS || hours > MAX_INVITE_TTL_HOURS) return null;
  return Math.round(hours * 60) / 60;
}

export type InviteState = 'active' | 'used' | 'expired' | 'revoked';

export function inviteState(row: { usedAt: Date | string | null; revokedAt: Date | string | null; expiresAt: Date | string }, now = Date.now()): InviteState {
  if (row.revokedAt) return 'revoked';
  if (row.usedAt) return 'used';
  return new Date(row.expiresAt).getTime() <= now ? 'expired' : 'active';
}
