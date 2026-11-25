import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  set: vi.fn(),
  updateWhere: vi.fn(),
  returning: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  selectWhere: vi.fn(),
  limit: vi.fn(),
  forUpdate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('./db', () => ({
  getDatabase: () => ({
    db: {
      update: mocks.update,
      insert: mocks.insert,
      select: mocks.select,
      transaction: mocks.transaction,
    },
  }),
}));

vi.mock('./chat-store', () => ({
  listMessages: vi.fn(),
}));

import { listMessages } from './chat-store';
import {
  createConversationShare,
  getActiveShare,
  hashShareToken,
  isShareTokenFormat,
  resolveShareToken,
  revokeConversationShares,
  shareExpiry,
} from './share-store';

function collect(value: unknown, key: 'name' | 'value', out: string[] = []): string[] {
  if (!value || typeof value !== 'object') return out;
  const item = value as Record<string, unknown>;
  if (typeof item[key] === 'string') out.push(String(item[key]));
  if (Array.isArray(item.queryChunks)) {
    for (const chunk of item.queryChunks) collect(chunk, key, out);
  }
  return out;
}

const conversationRow = {
  id: 'c1',
  userId: 'u1',
  title: 'Тема',
  archivedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.updateWhere });
  mocks.updateWhere.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([]);
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockResolvedValue(undefined);
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ innerJoin: mocks.innerJoin, where: mocks.selectWhere });
  mocks.innerJoin.mockReturnValue({ where: mocks.selectWhere });
  mocks.selectWhere.mockReturnValue({
    limit: mocks.limit,
    orderBy: () => ({ limit: mocks.limit }),
    for: mocks.forUpdate,
  });
  mocks.limit.mockResolvedValue([]);
  mocks.forUpdate.mockResolvedValue([conversationRow]);
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ insert: mocks.insert, update: mocks.update, select: mocks.select }),
  );
  vi.mocked(listMessages).mockResolvedValue({ items: [], total: 0, has_more: false } as never);
});

describe('share expiry and tokens', () => {
  it('computes deterministic expiries and hashes', () => {
    const now = new Date('2026-11-25T00:00:00Z');
    expect(shareExpiry('24h', now)?.toISOString()).toBe('2026-11-26T00:00:00.000Z');
    expect(shareExpiry('7d', now)?.toISOString()).toBe('2026-12-02T00:00:00.000Z');
    expect(shareExpiry('30d', now)?.toISOString()).toBe('2026-12-25T00:00:00.000Z');
    expect(shareExpiry('never', now)).toBeNull();
    expect(hashShareToken('token')).toHaveLength(64);
    expect(hashShareToken('token')).toBe(hashShareToken('token'));
  });

  it('accepts only 32-byte base64url tokens', () => {
    expect(isShareTokenFormat('a'.repeat(43))).toBe(true);
    expect(isShareTokenFormat('a'.repeat(42))).toBe(false);
    expect(isShareTokenFormat('a/b'.repeat(21))).toBe(false);
  });
});

describe('createConversationShare', () => {
  it('revokes the previous link and stores only the hash', async () => {
    const created = await createConversationShare('u1', 'c1', '7d');
    expect(mocks.forUpdate).toHaveBeenCalledWith('update');
    expect(created?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashShareToken(created!.token)).toHaveLength(64);
    const inserted = mocks.values.mock.calls[0][0] as Record<string, string | null>;
    expect(inserted).toMatchObject({
      conversationId: 'c1',
      userId: 'u1',
      tokenHash: hashShareToken(created!.token),
    });
    expect(inserted.expiresAt).toBeInstanceOf(Date);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }));
    expect(collect(mocks.updateWhere.mock.calls[0][0], 'name')).toContain('id');
  });

  it('refuses to share an archived conversation under the row lock', async () => {
    mocks.forUpdate.mockResolvedValue([{ ...conversationRow, archivedAt: new Date() }]);
    await expect(createConversationShare('u1', 'c1', '7d')).rejects.toThrow(
      'conversation_archived',
    );
    expect(mocks.values).not.toHaveBeenCalled();
  });

  it('does not create a link for a foreign conversation', async () => {
    mocks.forUpdate.mockResolvedValue([]);
    await expect(createConversationShare('u1', 'foreign', '7d')).resolves.toBeNull();
    expect(mocks.values).not.toHaveBeenCalled();
  });
});

describe('revokeConversationShares', () => {
  it('filters by owner and conversation', async () => {
    mocks.returning.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    await expect(revokeConversationShares('u1', 'c1')).resolves.toBe(2);
    const condition = mocks.updateWhere.mock.calls[0][0];
    expect(collect(condition, 'name')).toEqual(
      expect.arrayContaining(['user_id', 'conversation_id', 'revoked_at']),
    );
    expect(collect(condition, 'value')).toEqual(expect.arrayContaining(['u1', 'c1']));
  });
});

describe('resolveShareToken', () => {
  it('rejects malformed tokens without touching the database', async () => {
    await expect(resolveShareToken('short')).resolves.toBeNull();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns the conversation and its messages', async () => {
    const token = 'b'.repeat(43);
    mocks.limit.mockResolvedValue([{ conversation: conversationRow }]);
    vi.mocked(listMessages).mockResolvedValue({
      items: [{ id: 'm1', role: 'user', content: 'привет' }],
      total: 1,
      has_more: false,
    } as never);
    const shared = await resolveShareToken(token);
    expect(shared?.conversation.id).toBe('c1');
    expect(shared?.messages).toHaveLength(1);
    expect(shared?.total).toBe(1);
    expect(shared?.has_more).toBe(false);
    expect(listMessages).toHaveBeenCalledWith('u1', 'c1', { limit: 500, order: 'desc' });
    expect(collect(mocks.selectWhere.mock.calls[0][0], 'value')).toContain(hashShareToken(token));
  });

  it('returns null for expired, revoked or archived links', async () => {
    await expect(resolveShareToken('c'.repeat(43))).resolves.toBeNull();
    expect(listMessages).not.toHaveBeenCalled();
  });
});

describe('getActiveShare', () => {
  it('returns the active link metadata without the token', async () => {
    const expiresAt = new Date('2026-12-02T00:00:00Z');
    mocks.limit.mockResolvedValue([{ expiresAt }]);
    await expect(getActiveShare('u1', 'c1')).resolves.toEqual({ expiresAt });
    expect(collect(mocks.selectWhere.mock.calls[0][0], 'name')).toEqual(
      expect.arrayContaining(['user_id', 'conversation_id', 'revoked_at']),
    );
  });

  it('returns null when no link is active', async () => {
    mocks.limit.mockResolvedValue([]);
    await expect(getActiveShare('u1', 'c1')).resolves.toBeNull();
  });
});
