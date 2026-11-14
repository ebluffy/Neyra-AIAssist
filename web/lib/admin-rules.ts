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

export const INVITE_MAX_USES_LIMIT = 10000;
const RELATIVE_TTL_MS = 60 * 60 * 1000;

// AR-35: лимит использований. undefined — значение по умолчанию (одноразовый),
// null/'unlimited' — без лимита, число 1..10000. Иначе 'invalid'.
export function normalizeInviteMaxUses(value: unknown, fallback: number | null = 1): number | null | 'invalid' {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'string' && ['', 'unlimited', 'none', '∞'].includes(value.trim().toLowerCase())) return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > INVITE_MAX_USES_LIMIT) return 'invalid';
  return parsed;
}

// AR-35: срок. expiresAt (ISO) приоритетнее ttlHours; null у любого — без срока;
// undefined у обоих — прежние сутки. Прошедшая дата — 'invalid'.
export function normalizeInviteExpiry(
  value: { expiresAt?: unknown; ttlHours?: unknown },
  now = Date.now(),
): Date | null | 'invalid' {
  if (value.expiresAt === null) return null;
  if (typeof value.expiresAt === 'string' && value.expiresAt.trim()) {
    const at = new Date(value.expiresAt.trim());
    if (Number.isNaN(at.getTime()) || at.getTime() <= now) return 'invalid';
    return at;
  }
  if (value.ttlHours === null) return null;
  if (value.ttlHours === undefined) return new Date(now + 24 * RELATIVE_TTL_MS);
  const hours = normalizeInviteTtl(value.ttlHours);
  return hours === null ? 'invalid' : new Date(now + hours * RELATIVE_TTL_MS);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INVITE_EMAIL = 320;

// AR-35: необязательная привязка к адресу. null — любой; строка — только этот.
export function normalizeInviteEmail(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'invalid';
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > MAX_INVITE_EMAIL || !EMAIL_RE.test(email)) return 'invalid';
  return email;
}

export type InviteState = 'active' | 'used' | 'expired' | 'revoked';

// AR-35: «использован» — исчерпан лимит. max_uses = null — без лимита.
// Старые строки без maxUses в тестах трактуем по usedAt (совместимость).
export function inviteState(
  row: {
    usedAt: Date | string | null;
    revokedAt: Date | string | null;
    expiresAt: Date | string | null;
    maxUses?: number | null;
    usedCount?: number;
  },
  now = Date.now(),
): InviteState {
  if (row.revokedAt) return 'revoked';
  if (row.maxUses === undefined) {
    if (row.usedAt) return 'used';
  } else if (row.maxUses !== null && (row.usedCount ?? 0) >= row.maxUses) {
    return 'used';
  }
  if (!row.expiresAt) return 'active';
  return new Date(row.expiresAt).getTime() <= now ? 'expired' : 'active';
}
