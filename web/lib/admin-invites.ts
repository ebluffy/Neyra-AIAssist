import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { getDatabase } from './db';
import { invite, inviteUse } from '../db/schema';
import { recordAudit } from './admin-audit';
import { generateInviteToken, hashInviteToken } from './invite';
import { inviteState, pageOffset, type InviteListQuery, type InviteState } from './admin-rules';

export interface AdminInviteRow {
  id: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  email: string | null;
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

// AR-35: «использован» — исчерпан лимит (max_uses not null и used_count >=
// max_uses). Инвайт без лимита не становится used, только expired/revoked.
function exhaustedCondition(): SQL {
  return sql`${invite.maxUses} is not null and ${invite.usedCount} >= ${invite.maxUses}`;
}

function notExpiredCondition(now: Date): SQL {
  return or(isNull(invite.expiresAt), gt(invite.expiresAt, now))!;
}

function stateCondition(state: Exclude<InviteListQuery['state'], 'all'>): SQL {
  const now = new Date();
  switch (state) {
    case 'active':
      return and(isNull(invite.revokedAt), notExpiredCondition(now), sql`not (${exhaustedCondition()})`)!;
    case 'used':
      return exhaustedCondition();
    case 'revoked':
      return sql`${invite.revokedAt} is not null`;
    case 'expired':
      return and(isNull(invite.revokedAt), sql`not (${exhaustedCondition()})`, lte(invite.expiresAt, now))!;
  }
}

export async function countInvites(): Promise<InviteCounts> {
  const { db } = getDatabase();
  const now = new Date();
  const [row] = await db.select({
    total: count(),
    active: sql<number>`count(*) filter (where ${invite.revokedAt} is null and (${invite.expiresAt} is null or ${invite.expiresAt} > ${now}) and not (${exhaustedCondition()}))`,
    used: sql<number>`count(*) filter (where ${exhaustedCondition()})`,
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
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      email: row.email,
      usedBy: row.usedBy,
      usedAt: row.usedAt ? row.usedAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      state: inviteState(row),
    })),
  };
}

export interface CreateInviteOptions {
  /** null — без лимита; 1 — одноразовый. */
  maxUses: number | null;
  /** null — без срока. */
  expiresAt: Date | null;
  /** null — любой адрес; иначе только этот. */
  email: string | null;
}

export interface CreatedInvite {
  id: string;
  url: string;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  email: string | null;
}

// Ссылка строится из origin сайта; токен возвращается один раз и в базе не хранится.
export async function createInvite(createdBy: string, options: CreateInviteOptions, baseUrl: string): Promise<CreatedInvite> {
  const { db } = getDatabase();
  const token = generateInviteToken();
  const id = randomUUID();
  await db.insert(invite).values({
    id,
    tokenHash: hashInviteToken(token),
    createdBy,
    expiresAt: options.expiresAt,
    maxUses: options.maxUses,
    email: options.email,
  });
  return {
    id,
    expiresAt: options.expiresAt ? options.expiresAt.toISOString() : null,
    maxUses: options.maxUses,
    usedCount: 0,
    email: options.email,
    url: `${baseUrl.replace(/\/$/, '')}/signup?invite=${token}`,
  };
}

// AR-39: успешная регистрация по инвайту — audit invite.use и привязка
// использования к аккаунту. Журнал не ломает регистрацию, если запись не удалась.
export async function recordInviteUse(useId: string, email: string, userId: string | null): Promise<void> {
  try {
    const { db } = getDatabase();
    const rows = await db.update(inviteUse)
      .set({ userId })
      .where(eq(inviteUse.id, useId))
      .returning({ inviteId: inviteUse.inviteId });
    const row = rows[0];
    if (!row) return;
    // Без user.id актором остаётся email (или «система»), а не выдуманный id.
    await recordAudit(
      { id: userId ?? (email || 'system'), email: email || 'система' },
      'invite.use',
      { type: 'invite', id: row.inviteId },
      { email, userId },
    );
  } catch {
    // Журнал и привязка — не критичный путь регистрации.
  }
}

// Отзыв: работает и для многоразового инвайта с уже потраченными использованиями.
export async function revokeInvite(id: string): Promise<'ok' | 'not-found' | 'revoked'> {
  const { db } = getDatabase();
  const rows = await db.select().from(invite).where(eq(invite.id, id)).limit(1);
  const row = rows[0];
  if (!row) return 'not-found';
  if (row.revokedAt) return 'revoked';
  await db.update(invite).set({ revokedAt: new Date() }).where(and(eq(invite.id, id), isNull(invite.revokedAt)));
  return 'ok';
}
