import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionUser } from '../../../../../lib/user-session';
import {
  deleteConversation,
  getConversation,
  listMessages,
  updateConversation,
} from '../../../../../lib/chat-store';
import { DELETE, GET, PATCH } from './route';

vi.mock('../../../../../lib/user-session', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../../../../lib/chat-store', () => ({
  getConversation: vi.fn(),
  listMessages: vi.fn(),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
}));

const user = { id: 'u1', email: 'a@b.co', name: 'A', role: 'user' };
const context = { params: Promise.resolve({ id: 'c1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue(user);
});

describe('conversation API', () => {
  it('returns messages only for an owned conversation', async () => {
    vi.mocked(getConversation).mockResolvedValue({ id: 'c1' } as never);
    vi.mocked(listMessages).mockResolvedValue({
      items: [{ id: 'm1' }],
      total: 1,
      has_more: false,
    } as never);
    const response = await GET(
      new Request('http://localhost/api/conversations/c1?message_limit=10&message_offset=20'),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        conversation: { id: 'c1' },
        messages: [{ id: 'm1' }],
        total: 1,
        has_more: false,
      },
    });
    expect(listMessages).toHaveBeenCalledWith('u1', 'c1', { limit: 10, offset: 20 });

    vi.mocked(getConversation).mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/conversations/c1'), context)).status).toBe(404);
  });

  it('patches title and pin, rejecting invalid values', async () => {
    vi.mocked(updateConversation).mockResolvedValue({ id: 'c1', pinned: true } as never);
    const response = await PATCH(
      new Request('http://localhost/api/conversations/c1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Новое', pinned: true }),
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(updateConversation).toHaveBeenCalledWith('u1', 'c1', { title: 'Новое', pinned: true });

    const bad = await PATCH(
      new Request('http://localhost/api/conversations/c1', {
        method: 'PATCH',
        body: JSON.stringify({ pinned: 'yes' }),
      }),
      context,
    );
    expect(bad.status).toBe(400);

    const emptyFolder = await PATCH(
      new Request('http://localhost/api/conversations/c1', {
        method: 'PATCH',
        body: JSON.stringify({ folderId: '' }),
      }),
      context,
    );
    expect(emptyFolder.status).toBe(400);
    expect(updateConversation).not.toHaveBeenCalledWith('u1', 'c1', { folderId: '' });

    vi.mocked(updateConversation).mockRejectedValue(new Error('folder_not_found'));
    const missingFolder = await PATCH(
      new Request('http://localhost/api/conversations/c1', {
        method: 'PATCH',
        body: JSON.stringify({ folderId: 'foreign' }),
      }),
      context,
    );
    expect(missingFolder.status).toBe(404);
  });

  it('archives a conversation', async () => {
    vi.mocked(deleteConversation).mockResolvedValue(true);
    expect((await DELETE(new Request('http://localhost/api/conversations/c1'), context)).status).toBe(200);
    vi.mocked(deleteConversation).mockResolvedValue(false);
    expect((await DELETE(new Request('http://localhost/api/conversations/c1'), context)).status).toBe(404);
  });
});
