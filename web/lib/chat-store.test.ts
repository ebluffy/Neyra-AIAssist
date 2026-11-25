import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn();
  const from = vi.fn();
  const select = vi.fn();
  const updateWhere = vi.fn();
  const returning = vi.fn();
  const set = vi.fn();
  const update = vi.fn();
  const deleteWhere = vi.fn();
  const deleteReturning = vi.fn();
  const remove = vi.fn();
  return {
    limit, where, from, select,
    updateWhere, returning, set, update,
    deleteWhere, deleteReturning, remove,
  };
});

vi.mock('./db', () => ({
  getDatabase: () => ({
    db: { select: mocks.select, update: mocks.update, delete: mocks.remove },
  }),
}));

import {
  clampLimit,
  deleteConversation,
  listConversations,
  updateConversation,
  upsertMessage,
  ensureConversation,
  clampOffset,
  conversationOwnerWhere,
  conversationOwnershipWhere,
  deriveConversationTitle,
  folderOwnershipWhere,
  getConversation,
} from './chat-store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockResolvedValue([]);
  mocks.where.mockReturnValue({ limit: mocks.limit });
  mocks.from.mockReturnValue({ where: mocks.where });
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.updateWhere });
  mocks.updateWhere.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([{ id: 'c1' }]);
  mocks.remove.mockReturnValue({ where: mocks.deleteWhere });
  mocks.deleteWhere.mockReturnValue({ returning: mocks.deleteReturning });
  mocks.deleteReturning.mockResolvedValue([{ id: 'c1' }]);
});

function collect(value: unknown, key: 'name' | 'value', out: string[] = []): string[] {
  if (!value || typeof value !== 'object') return out;
  const item = value as Record<string, unknown>;
  if (typeof item[key] === 'string') out.push(String(item[key]));
  if (Array.isArray(item.queryChunks)) {
    for (const chunk of item.queryChunks) collect(chunk, key, out);
  }
  return out;
}

describe('deriveConversationTitle', () => {
  it('takes the first line and caps it', () => {
    expect(deriveConversationTitle('  Привет\nвторая строка  ')).toBe('Привет');
    expect(deriveConversationTitle('')).toBe('Новый диалог');
    expect(deriveConversationTitle('x'.repeat(200))).toHaveLength(80);
  });
});

describe('chat-store ownership', () => {
  it('selects a conversation by both id and user_id', async () => {
    mocks.limit.mockResolvedValue([{ id: 'c1', userId: 'u1', archivedAt: null }]);
    await getConversation('u1', 'c1');

    expect(mocks.select).toHaveBeenCalled();
    const condition = mocks.where.mock.calls[0][0];
    expect(collect(condition, 'name')).toEqual(expect.arrayContaining(['id', 'user_id']));
    expect(collect(condition, 'value')).toEqual(expect.arrayContaining(['c1', 'u1']));
  });

  it('returns null when the row is not owned', async () => {
    mocks.limit.mockResolvedValue([]);
    await expect(getConversation('u1', 'foreign')).resolves.toBeNull();
  });

  it('refuses to create a conversation whose id belongs to another user', async () => {
    mocks.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'c1' }]);
    await expect(ensureConversation('u1', 'c1', 'Привет')).rejects.toThrow(
      'conversation_forbidden',
    );
  });
});


describe('ownership SQL and page clamps', () => {
  it('conversation filters include id and user_id', () => {
    const condition = conversationOwnershipWhere('u1', 'c1');
    expect(collect(condition, 'name')).toEqual(expect.arrayContaining(['id', 'user_id']));
    expect(collect(condition, 'value')).toEqual(expect.arrayContaining(['c1', 'u1']));
  });

  it('list and folder filters include user_id', () => {
    expect(collect(conversationOwnerWhere('u1'), 'name')).toContain('user_id');
    expect(collect(conversationOwnerWhere('u1'), 'value')).toContain('u1');
    expect(collect(folderOwnershipWhere('u1', 'f1'), 'name')).toEqual(
      expect.arrayContaining(['id', 'user_id']),
    );
    expect(collect(folderOwnershipWhere('u1', 'f1'), 'value')).toEqual(
      expect.arrayContaining(['f1', 'u1']),
    );
  });

  it('clamps page sizes and offsets', () => {
    expect(clampLimit(0, 50, 100)).toBe(1);
    expect(clampLimit(1000, 50, 100)).toBe(100);
    expect(clampLimit(undefined, 200, 500)).toBe(200);
    expect(clampOffset(-5)).toBe(0);
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(20)).toBe(20);
  });
});


describe('mutation ownership filters', () => {
  it('deleteConversation filters by id and user_id', async () => {
    await deleteConversation('u1', 'c1');
    const condition = mocks.updateWhere.mock.calls[0][0];
    expect(collect(condition, 'name')).toEqual(expect.arrayContaining(['id', 'user_id']));
    expect(collect(condition, 'value')).toEqual(expect.arrayContaining(['c1', 'u1']));
  });

  it('updateConversation filters the final update by id and user_id', async () => {
    mocks.limit.mockResolvedValue([{ id: 'c1', userId: 'u1', archivedAt: null }]);
    await updateConversation('u1', 'c1', { pinned: true });
    const condition = mocks.updateWhere.mock.calls[0][0];
    expect(collect(condition, 'name')).toEqual(expect.arrayContaining(['id', 'user_id']));
    expect(collect(condition, 'value')).toEqual(expect.arrayContaining(['c1', 'u1']));
  });

  it('rejects a folder owned by another user', async () => {
    mocks.limit
      .mockResolvedValueOnce([{ id: 'c1', userId: 'u1', archivedAt: null }])
      .mockResolvedValueOnce([]);
    await expect(updateConversation('u1', 'c1', { folderId: 'f1' })).rejects.toThrow(
      'folder_not_found',
    );
    expect(mocks.update).not.toHaveBeenCalled();
    const folderCondition = mocks.where.mock.calls[1][0];
    expect(collect(folderCondition, 'name')).toEqual(
      expect.arrayContaining(['id', 'user_id']),
    );
    expect(collect(folderCondition, 'value')).toEqual(expect.arrayContaining(['f1', 'u1']));
  });

  it('accepts an owned folder', async () => {
    mocks.limit
      .mockResolvedValueOnce([{ id: 'c1', userId: 'u1', archivedAt: null }])
      .mockResolvedValueOnce([{ id: 'f1' }]);
    await updateConversation('u1', 'c1', { folderId: 'f1' });
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: 'f1' }),
    );
  });

  it('includeArchived keeps the user filter and drops archived_at', async () => {
    const chain: Record<string, unknown> = {};
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => Promise.resolve([]));
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    mocks.where
      .mockReturnValueOnce(Promise.resolve([{ count: 0 }]))
      .mockReturnValueOnce(chain);
    await listConversations('u1', { includeArchived: true });
    const condition = mocks.where.mock.calls[1][0];
    const names = collect(condition, 'name');
    expect(names).toContain('user_id');
    expect(names).not.toContain('archived_at');
  });

  it('listConversations filters by user and excludes archived by default', async () => {
    const chain: Record<string, unknown> = {};
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => Promise.resolve([{ id: 'c1' }]));
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve([{ id: 'c1' }]).then(resolve, reject);
    mocks.where
      .mockReturnValueOnce(Promise.resolve([{ count: 1 }]))
      .mockReturnValueOnce(chain);
    await listConversations('u1');
    const condition = mocks.where.mock.calls[1][0];
    expect(collect(condition, 'name')).toEqual(
      expect.arrayContaining(['user_id', 'archived_at']),
    );
    expect(collect(condition, 'value')).toContain('u1');
  });
});

describe('message updates', () => {
  it('updates an existing answer in place without touching createdAt', async () => {
    mocks.limit.mockResolvedValue([{ id: 'c1', userId: 'u1', archivedAt: null }]);
    mocks.returning.mockResolvedValue([{ id: 'm1', content: 'новый ответ' }]);
    await upsertMessage('u1', 'c1', {
      id: 'm1',
      role: 'assistant',
      content: 'новый ответ',
      status: 'done',
    });
    expect(mocks.set).toHaveBeenCalled();
    const patch = mocks.set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).toMatchObject({ content: 'новый ответ', status: 'done' });
    expect(patch).not.toHaveProperty('createdAt');
  });
});
