import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, type SQL } from 'drizzle-orm';
import { getDatabase } from './db';
import { adminAudit } from '../db/schema';

// Журнал действий админки. Секреты и пароли сюда не попадают: details — только
// идентификаторы и новые значения полей, которые и так видны в интерфейсе.

export interface AuditActor {
  id: string;
  email: string;
}

export type AuditDetails = Record<string, string | number | boolean | null>;

export async function recordAudit(
  actor: AuditActor,
  action: string,
  target: { type: string; id: string } | null,
  details: AuditDetails = {},
): Promise<void> {
  try {
    const { db } = getDatabase();
    await db.insert(adminAudit).values({
      id: randomUUID(),
      actorId: actor.id,
      actorEmail: actor.email,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      details,
    });
  } catch {
    // Журнал не должен ломать само действие: ошибка записи не отменяет смену роли.
  }
}

export interface AuditRow {
  id: string;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: AuditDetails | null;
  createdAt: string;
}

export interface AuditQuery {
  limit: number;
  action: string;
  since: Date | null;
}

export function parseAuditQuery(params: URLSearchParams | Record<string, string | string[] | undefined>): AuditQuery {
  const get = (name: string): string => {
    if (params instanceof URLSearchParams) return (params.get(name) ?? '').trim();
    const value = params[name];
    return (Array.isArray(value) ? value[0] ?? '' : value ?? '').trim();
  };
  const limitRaw = Number.parseInt(get('limit'), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const action = get('action').replace(/[^a-z0-9_.-]/gi, '').slice(0, 60);
  let since: Date | null = null;
  const sinceRaw = get('since');
  if (sinceRaw) {
    const parsed = new Date(sinceRaw);
    if (!Number.isNaN(parsed.getTime())) since = parsed;
  }
  return { limit, action, since };
}

export async function listAudit(query: AuditQuery): Promise<AuditRow[]> {
  const { db } = getDatabase();
  const filters: SQL[] = [];
  if (query.action) filters.push(eq(adminAudit.action, query.action));
  if (query.since) filters.push(gte(adminAudit.createdAt, query.since));
  const rows = await db.select().from(adminAudit)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(adminAudit.createdAt))
    .limit(query.limit);
  return rows.map(row => ({
    id: row.id,
    actorEmail: row.actorEmail,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    details: (row.details as AuditDetails | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function countAudit(): Promise<number> {
  const { db } = getDatabase();
  const [row] = await db.select({ value: count() }).from(adminAudit);
  return Number(row?.value ?? 0);
}

// Для дашборда: сколько записей за последние сутки.
export async function countAuditSince(since: Date): Promise<number> {
  const { db } = getDatabase();
  const [row] = await db.select({ value: count() }).from(adminAudit).where(gte(adminAudit.createdAt, since));
  return Number(row?.value ?? 0);
}
