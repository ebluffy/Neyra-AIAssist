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

export async function getUser(id: string): Promise<{ id: string; email: string; role: 'admin' | 'user'; banned: boolean } | null> {
  const { db } = getDatabase();
  const rows = await db.select({ id: user.id, email: user.email, role: user.role, banned: user.banned })
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

export async function setUserRole(actorId: string, targetId: string, nextRole: 'admin' | 'user'): Promise<MutationResult<{ role: string }>> {
  const target = await getUser(targetId);
  if (!target) return { ok: false, error: 'not-found' };
  if (target.id === actorId && nextRole !== 'admin') return { ok: false, error: 'self' };
  try {
    const { db } = getDatabase();
    // AR-30: блокируем строки админов в транзакции. Подзапрос в одном UPDATE
    // не спасает от write skew: две транзакции видят «2 админа» и обе коммитятся.
    const outcome = await db.transaction(async (tx) => {
      // Advisory-lock сериализует все изменения ролей: FOR UPDATE не спасает,
      // если обе транзакции успели прочитать «2 админа» до блокировки строк.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(734002)`);
      // AR-34: роль цели перечитывается внутри блокировки. Чтение до транзакции
      // устаревает: цель могли повысить или понизить, пока мы ждали lock, и
      // проверка «последний админ» опиралась бы на старое значение.
      const current = await tx.execute(sql`SELECT role FROM "user" WHERE id = ${targetId} FOR UPDATE`);
      const currentRole = (current.rows[0] as { role?: string } | undefined)?.role;
      if (!currentRole) return 'not-found' as const;
      const counted = await tx.execute(sql`SELECT count(*)::int AS admins FROM "user" WHERE role = 'admin'`);
      const adminCount = Number((counted.rows[0] as { admins?: number } | undefined)?.admins ?? 0);
      if (currentRole === 'admin' && nextRole !== 'admin' && adminCount <= 1) {
        return 'last-admin' as const;
      }
      const updated = await tx.execute(sql`
        UPDATE "user" SET role = ${nextRole}, updated_at = now()
        WHERE id = ${targetId}
        RETURNING id
      `);
      const changed = updated.rows.length;
      return changed ? ('ok' as const) : ('not-found' as const);
    });
    if (outcome === 'last-admin') return { ok: false, error: 'last-admin' };
    if (outcome === 'not-found') return { ok: false, error: 'not-found' };
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
  if (target.id === actorId) return { ok: false, error: 'self' };
  try {
    const { db } = getDatabase();
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(734002)`);
      // AR-34: свежая роль внутри блокировки — за время ожидания цель могли
      // повысить до админа, и удаление последнего админа прошло бы проверку.
      const current = await tx.execute(sql`SELECT role FROM "user" WHERE id = ${targetId} FOR UPDATE`);
      const currentRole = (current.rows[0] as { role?: string } | undefined)?.role;
      if (!currentRole) return 'not-found' as const;
      const counted = await tx.execute(sql`SELECT count(*)::int AS admins FROM "user" WHERE role = 'admin'`);
      const adminCount = Number((counted.rows[0] as { admins?: number } | undefined)?.admins ?? 0);
      if (currentRole === 'admin' && adminCount <= 1) return 'last-admin' as const;
      const deleted = await tx.execute(sql`DELETE FROM "user" WHERE id = ${targetId} RETURNING id`);
      const changed = deleted.rows.length;
      return changed ? ('ok' as const) : ('not-found' as const);
    });
    if (outcome === 'last-admin') return { ok: false, error: 'last-admin' };
    if (outcome === 'not-found') return { ok: false, error: 'not-found' };
    return { ok: true, value: { email: target.email } };
  } catch {
    return { ok: false, error: 'db' };
  }
}

// Бан по id — для хука создания сессии (AR-28).
export async function isUserBanned(id: string): Promise<boolean> {
  const { db } = getDatabase();
  const rows = await db.select({ banned: user.banned }).from(user).where(eq(user.id, id)).limit(1);
  return Boolean(rows[0]?.banned);
}

export async function touchLastLogin(email: string): Promise<void> {
  try {
    const { db } = getDatabase();
    await db.update(user).set({ lastLoginAt: new Date() }).where(sql`lower(${user.email}) = lower(${email})`);
  } catch {
    // Время входа не критично: ошибка не должна мешать входу.
  }
}
