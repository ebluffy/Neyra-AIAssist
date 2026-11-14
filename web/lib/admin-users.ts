import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDatabase } from './db';
import { session, user } from '../db/schema';
import { checkDelete, checkRoleChange, pageOffset, type AdminActionError, type UserListQuery } from './admin-rules';

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  banned: boolean;
  banReason: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserPage {
  items: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserCounts {
  total: number;
  admins: number;
  banned: number;
}

export async function countUsers(): Promise<UserCounts> {
  const { db } = getDatabase();
  const [row] = await db.select({
    total: count(),
    admins: sql<number>`count(*) filter (where ${user.role} = 'admin')`,
    banned: sql<number>`count(*) filter (where ${user.banned})`,
  }).from(user);
  return {
    total: Number(row?.total ?? 0),
    admins: Number(row?.admins ?? 0),
    banned: Number(row?.banned ?? 0),
  };
}

export async function listUsers(query: UserListQuery): Promise<UserPage> {
  const { db } = getDatabase();
  const filters: SQL[] = [];
  if (query.q) {
    const pattern = `%${query.q}%`;
    filters.push(or(ilike(user.email, pattern), ilike(user.name, pattern))!);
  }
  if (query.role !== 'all') filters.push(eq(user.role, query.role));
  if (query.status === 'banned') filters.push(eq(user.banned, true));
  if (query.status === 'active') filters.push(eq(user.banned, false));
  const where = filters.length ? and(...filters) : undefined;

  const [totalRow] = await db.select({ value: count() }).from(user).where(where);
  const rows = await db.select({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    banned: user.banned,
    banReason: user.banReason,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  }).from(user).where(where)
    .orderBy(desc(user.createdAt))
    .limit(query.pageSize)
    .offset(pageOffset(query.page, query.pageSize));

  // Последний вход: отдельным запросом по странице, чтобы не тащить join в счётчик.
  const lastByUser = new Map<string, Date>();
  if (rows.length) {
    const lastRows = await db.select({
      userId: session.userId,
      last: sql<Date | null>`max(${session.createdAt})`,
    }).from(session)
      .where(inArray(session.userId, rows.map(row => row.id)))
      .groupBy(session.userId);
    for (const row of lastRows) if (row.last) lastByUser.set(row.userId, new Date(row.last));
  }

  return {
    total: Number(totalRow?.value ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map(row => {
      const fromSession = lastByUser.get(row.id);
      const last = row.lastLoginAt && fromSession
        ? (row.lastLoginAt > fromSession ? row.lastLoginAt : fromSession)
        : row.lastLoginAt ?? fromSession ?? null;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role as 'admin' | 'user',
        banned: row.banned,
        banReason: row.banReason,
        createdAt: row.createdAt.toISOString(),
        lastLoginAt: last ? last.toISOString() : null,
      };
    }),
  };
}

export async function getUser(id: string): Promise<{ id: string; name: string; email: string; role: 'admin' | 'user'; banned: boolean } | null> {
  const { db } = getDatabase();
  const rows = await db.select({ id: user.id, name: user.name, email: user.email, role: user.role, banned: user.banned })
    .from(user).where(eq(user.id, id)).limit(1);
  const row = rows[0];
  return row ? { ...row, role: row.role as 'admin' | 'user' } : null;
}

export async function adminCount(): Promise<number> {
  const { db } = getDatabase();
  const [row] = await db.select({ value: count() }).from(user).where(eq(user.role, 'admin'));
  return Number(row?.value ?? 0);
}

export type MutationResult<T> = { ok: true; value: T } | { ok: false; error: AdminActionError | 'db' };

export async function setUserName(targetId: string, name: string): Promise<MutationResult<{ name: string }>> {
  const target = await getUser(targetId);
  if (!target) return { ok: false, error: 'not-found' };
  try {
    const { db } = getDatabase();
    await db.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, targetId));
    return { ok: true, value: { name } };
  } catch {
    return { ok: false, error: 'db' };
  }
}

export async function setUserRole(actorId: string, targetId: string, nextRole: 'admin' | 'user'): Promise<MutationResult<{ role: string }>> {
  const target = await getUser(targetId);
  if (!target) return { ok: false, error: 'not-found' };
  const verdict = checkRoleChange(actorId, target, nextRole, await adminCount());
  if (verdict) return { ok: false, error: verdict };
  try {
    const { db } = getDatabase();
    await db.update(user).set({ role: nextRole, updatedAt: new Date() }).where(eq(user.id, targetId));
    return { ok: true, value: { role: nextRole } };
  } catch {
    return { ok: false, error: 'db' };
  }
}

export async function setUserBanned(targetId: string, banned: boolean, reason: string | null): Promise<MutationResult<{ banned: boolean }>> {
  const target = await getUser(targetId);
  if (!target) return { ok: false, error: 'not-found' };
  try {
    const { db } = getDatabase();
    await db.update(user)
      .set({ banned, banReason: banned ? (reason ?? null) : null, updatedAt: new Date() })
      .where(eq(user.id, targetId));
    if (banned) {
      // Блокировка должна действовать сразу: живые сессии удаляются,
      // иначе открытая вкладка продолжает работать со старым cookie.
      await db.delete(session).where(eq(session.userId, targetId));
    }
    return { ok: true, value: { banned } };
  } catch {
    return { ok: false, error: 'db' };
  }
}

export async function deleteUser(actorId: string, targetId: string): Promise<MutationResult<{ email: string }>> {
  const target = await getUser(targetId);
  if (!target) return { ok: false, error: 'not-found' };
  const verdict = checkDelete(actorId, target, await adminCount());
  if (verdict) return { ok: false, error: verdict };
  try {
    const { db } = getDatabase();
    await db.delete(user).where(eq(user.id, targetId));
    return { ok: true, value: { email: target.email } };
  } catch {
    return { ok: false, error: 'db' };
  }
}

// Пользователь по email — для проверки блокировки при входе.
export async function findBannedByEmail(email: string): Promise<{ banned: boolean; banReason: string | null } | null> {
  const { db } = getDatabase();
  const rows = await db.select({ banned: user.banned, banReason: user.banReason })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
}

export async function touchLastLogin(email: string): Promise<void> {
  try {
    const { db } = getDatabase();
    await db.update(user).set({ lastLoginAt: new Date() }).where(sql`lower(${user.email}) = lower(${email})`);
  } catch {
    // Время входа не критично: ошибка не должна мешать входу.
  }
}
