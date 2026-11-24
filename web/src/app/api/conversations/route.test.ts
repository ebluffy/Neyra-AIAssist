import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionUser } from '../../../../lib/user-session';
import { ensureConversation, listConversations } from '../../../../lib/chat-store';
import { GET, POST } from './route';

vi.mock('../../../../lib/user-session', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../../../lib/chat-store', () => ({
  listConversations: vi.fn(),
  ensureConversation: vi.fn(),
}));

const user = { id: 'u1', email: 'a@b.co', name: 'A', role: 'user' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue(user);
});

describe('conversations API', () => {
  it('requires a session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/conversations'))).status).toBe(401);
    expect((await POST(new Request('http://localhost/api/conversations', { method: 'POST', body: '{}' }))).status).toBe(401);
  });

  it('lists conversations for the current user with pagination', async () => {
    vi.mocked(listConversations).mockResolvedValue({ items: [{ id: 'c1' }], total: 1, has_more: false } as never);
    const response = await GET(
      new Request('http://localhost/api/conversations?limit=2&offset=5'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { items: [{ id: 'c1' }], total: 1, has_more: false } });
    expect(listConversations).toHaveBeenCalledWith('u1', { limit: 2, offset: 5 });
  });

  it('creates a conversation and rejects a foreign id', async () => {
    vi.mocked(ensureConversation).mockResolvedValue({ id: 'c1' } as never);
    const response = await POST(
      new Request('http://localhost/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Привет', model: 'm' }),
      }),
    );
    expect(response.status).toBe(201);
    expect(ensureConversation).toHaveBeenCalledWith('u1', expect.any(String), 'Привет', 'm');

    vi.mocked(ensureConversation).mockRejectedValue(new Error('conversation_forbidden'));
    const forbidden = await POST(
      new Request('http://localhost/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ id: '123e4567-e89b-12d3-a456-426614174000' }),
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  it('rejects a malformed id instead of silently replacing it', async () => {
    const response = await POST(
      new Request('http://localhost/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ id: 'not-a-uuid' }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects malformed bodies', async () => {
    const response = await POST(
      new Request('http://localhost/api/conversations', { method: 'POST', body: 'not-json' }),
    );
    expect(response.status).toBe(400);
  });
});
