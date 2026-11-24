import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionUser } from '../../../../../../../lib/user-session';
import { deleteMessage } from '../../../../../../../lib/chat-store';
import { DELETE } from './route';

vi.mock('../../../../../../../lib/user-session', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../../../../../../lib/chat-store', () => ({ deleteMessage: vi.fn() }));

const user = { id: 'u1', email: 'a@b.co', name: 'A', role: 'user' };
const context = { params: Promise.resolve({ id: 'c1', messageId: 'm1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue(user);
});

describe('DELETE /api/conversations/[id]/messages/[messageId]', () => {
  it('requires a session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const response = await DELETE(new Request('http://localhost/api/conversations/c1/messages/m1'), context);
    expect(response.status).toBe(401);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('deletes the answer together with its question', async () => {
    vi.mocked(deleteMessage).mockResolvedValue(true);
    const response = await DELETE(new Request('http://localhost/api/conversations/c1/messages/m1'), context);
    expect(response.status).toBe(200);
    expect(deleteMessage).toHaveBeenCalledWith('u1', 'c1', 'm1', { withPreviousUser: true });
  });

  it('returns 404 for a foreign or missing message', async () => {
    vi.mocked(deleteMessage).mockResolvedValue(false);
    const response = await DELETE(new Request('http://localhost/api/conversations/c1/messages/m1'), context);
    expect(response.status).toBe(404);
  });

  it('hides store errors behind a stable code', async () => {
    vi.mocked(deleteMessage).mockRejectedValue(new Error('conversation_not_found'));
    expect(
      (await DELETE(new Request('http://localhost/api/conversations/c1/messages/m1'), context)).status,
    ).toBe(404);
    vi.mocked(deleteMessage).mockRejectedValue(new Error('db is down'));
    const response = await DELETE(new Request('http://localhost/api/conversations/c1/messages/m1'), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'history_unavailable' });
  });
});
