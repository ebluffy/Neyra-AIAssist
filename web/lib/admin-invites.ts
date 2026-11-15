import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { getDatabase } from './db';
import { invite } from '../db/schema';
import { generateInviteToken, hashInviteToken, INVITE_TTL_MS } from './invite';
import { inviteState, pageOffset, type InviteListQuery, type InviteState } from './admin-rules';

export interface AdminInviteRow {
  id: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  state: InviteState;
}

export interface InvitePage {
  items: AdminInviteRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InviteCounts {
  total: number;
  active: number;
  used: number;
}

function stateCondition(state: Exclude<InviteListQuery['state'], 'all'>): SQL {
  const now = new Date();
  switch (state) {
    case 'active':
      return and(isNull(invite.usedAt), isNull(invite.revokedAt), gt(invite.expiresAt, now))!;
    case 'used':
      return sql`${invite.usedAt} is not null`;
    case 'revoked':
      return sql`${invite.revokedAt} is not null`;
    case 'expired':
      return and(isNull(invite.usedAt), isNull(invite.revokedAt), lte(invite.expiresAt, now))!;
  }
}

export async function countInvites(): Promise<InviteCounts> {
  const { db } = getDatabase();
  const now = new Date();
  const [row] = await db.select({
    total: count(),
    active: sql<number>`count(*) filter (where ${invite.usedAt} is null and ${invite.revokedAt} is null and ${invite.expiresAt} > ${now})`,
    used: sql<number>`count(*) filter (where ${invite.usedAt} is not null)`,
  }).from(invite);
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    used: Number(row?.used ?? 0),
  };
}

export async function listInvites(query: InviteListQuery): Promise<InvitePage> {
  const { db } = getDatabase();
  const where = query.state === 'all' ? undefined : stateCondition(query.state);
  const [totalRow] = await db.select({ value: count() }).from(invite).where(where);
  const rows = await db.select().from(invite).where(where)
    .orderBy(desc(invite.createdAt))
    .limit(query.pageSize)
    .offset(pageOffset(query.page, query.pageSize));
  return {
    total: Number(totalRow?.value ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map(row => ({
      id: row.id,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      usedBy: row.usedBy,
      usedAt: row.usedAt ? row.usedAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      state: inviteState(row),
    })),
  };
}

export interface CreatedInvite {
  id: string;
  url: string;
  expiresAt: string;
}

// Ссылка строится из origin сайта; токен возвращается один раз и в базе не хранится.
export async function createInvite(createdBy: string, ttlHours: number, baseUrl: string): Promise<CreatedInvite> {
  const { db } = getDatabase();
  const token = generateInviteToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db.insert(invite).values({
    id,
    tokenHash: hashInviteToken(token),
    createdBy,
    expiresAt,
  });
  return {
    id,
    expiresAt: expiresAt.toISOString(),
    url: `${baseUrl.replace(/\/$/, '')}/signup?invite=${token}`,
  };
}

export async function revokeInvite(id: string): Promise<'ok' | 'not-found' | 'used' | 'revoked'> {
  const { db } = getDatabase();
  const rows = await db.select().from(invite).where(eq(invite.id, id)).limit(1);
  const row = rows[0];
  if (!row) return 'not-found';
  if (row.revokedAt) return 'revoked';
  if (row.usedAt) return 'used';
  await db.update(invite).set({ revokedAt: new Date() }).where(and(eq(invite.id, id), isNull(invite.revokedAt)));
  return 'ok';
}

export { INVITE_TTL_MS };
