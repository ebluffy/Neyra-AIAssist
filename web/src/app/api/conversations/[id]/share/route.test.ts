import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionUser } from '../../../../../../lib/user-session';
import {
  createConversationShare,
  getActiveShare,
  revokeConversationShares,
} from '../../../../../../lib/share-store';
import { getConversation } from '../../../../../../lib/chat-store';
import { DELETE, GET, POST } from './route';

vi.mock('../../../../../../lib/user-session', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../../../../../lib/share-store', () => ({
  createConversationShare: vi.fn(),
  revokeConversationShares: vi.fn(),
  getActiveShare: vi.fn(),
  SHARE_TTLS: ['24h', '7d', '30d', 'never'],
}));
vi.mock('../../../../../../lib/chat-store', () => ({ getConversation: vi.fn() }));

const user = { id: 'u1', email: 'a@b.co', name: 'A', role: 'user' };
const context = { params: Promise.resolve({ id: 'c1' }) };

function request(body?: unknown, method = 'POST'): Request {
  return new Request('http://localhost/api/conversations/c1/share', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue(user);
  vi.mocked(createConversationShare).mockResolvedValue({
    id: 's1',
    token: 't'.repeat(43),
    expiresAt: new Date('2026-12-02T00:00:00Z'),
  });
  vi.mocked(revokeConversationShares).mockResolvedValue(1);
  vi.mocked(getActiveShare).mockResolvedValue(null);
  vi.mocked(getConversation).mockResolvedValue({ id: 'c1' } as never);
});

describe('share API', () => {
  it('requires a session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await POST(request({ ttl: '7d' }), context)).status).toBe(401);
    expect((await DELETE(request(undefined, 'DELETE'), context)).status).toBe(401);
    expect((await GET(request(undefined, 'GET'), context)).status).toBe(401);
    expect(createConversationShare).not.toHaveBeenCalled();
  });

  it('rejects an unknown ttl', async () => {
    expect((await POST(request({ ttl: '1y' }), context)).status).toBe(400);
    expect(createConversationShare).not.toHaveBeenCalled();
  });

  it('creates a link and returns a relative url', async () => {
    const response = await POST(request({ ttl: '30d' }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { url: `/share/${'t'.repeat(43)}`, expires_at: '2026-12-02T00:00:00.000Z' },
    });
    expect(createConversationShare).toHaveBeenCalledWith('u1', 'c1', '30d');
  });

  it('returns 404 for a foreign conversation and 409 for an archived one', async () => {
    vi.mocked(createConversationShare).mockResolvedValueOnce(null);
    expect((await POST(request({ ttl: '7d' }), context)).status).toBe(404);

    vi.mocked(createConversationShare).mockRejectedValueOnce(new Error('conversation_archived'));
    expect((await POST(request({ ttl: '7d' }), context)).status).toBe(409);
  });

  it('reports the active link without exposing the token', async () => {
    vi.mocked(getActiveShare).mockResolvedValue({ expiresAt: new Date('2026-12-02T00:00:00Z') });
    const response = await GET(request(undefined, 'GET'), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { active: true, expires_at: '2026-12-02T00:00:00.000Z' },
    });
    expect(getActiveShare).toHaveBeenCalledWith('u1', 'c1');

    vi.mocked(getActiveShare).mockResolvedValue(null);
    const inactive = await GET(request(undefined, 'GET'), context);
    expect(await inactive.json()).toEqual({
      ok: true,
      data: { active: false, expires_at: null },
    });
  });

  it('returns 404 for the active-link lookup on a foreign conversation', async () => {
    vi.mocked(getConversation).mockResolvedValue(null);
    expect((await GET(request(undefined, 'GET'), context)).status).toBe(404);
    expect(getActiveShare).not.toHaveBeenCalled();
  });

  it('revokes active links', async () => {
    const response = await DELETE(request(undefined, 'DELETE'), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { revoked: 1 } });
    expect(revokeConversationShares).toHaveBeenCalledWith('u1', 'c1');
  });

  it('hides storage failures behind a stable code', async () => {
    vi.mocked(createConversationShare).mockRejectedValueOnce(new Error('db down'));
    const response = await POST(request({ ttl: '7d' }), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'share_unavailable' });
  });
});
