import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH } from './route';
import { getAuth } from '../../../../lib/auth';
import { setUserName } from '../../../../lib/admin-users';

vi.mock('../../../../lib/auth', () => ({ getAuth: vi.fn() }));
vi.mock('../../../../lib/admin-users', () => ({ setUserName: vi.fn() }));

function session(role: 'user' | 'admin') {
  return { user: { id: 'usr-42', name: 'Алиса', email: 'alice@example.test', role } };
}

function patch(body: unknown): Request {
  return new Request('http://localhost/api/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuth).mockReturnValue({
    api: { getSession: vi.fn().mockResolvedValue(session('user')) },
  } as unknown as ReturnType<typeof getAuth>);
  vi.mocked(setUserName).mockResolvedValue({ ok: true, value: { name: 'Боб' } });
});

describe('PATCH /api/me (AR-74)', () => {
  it('lets a non-admin user rename themselves', async () => {
    const response = await PATCH(patch({ name: '  Боб  ' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { name: 'Боб' } });
    expect(setUserName).toHaveBeenCalledWith('usr-42', 'Боб');
  });

  it('rejects an empty name', async () => {
    const response = await PATCH(patch({ name: '   ' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: 'bad_request' });
    expect(setUserName).not.toHaveBeenCalled();
  });

  it('rejects a request without a session', async () => {
    vi.mocked(getAuth).mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    } as unknown as ReturnType<typeof getAuth>);
    const response = await PATCH(patch({ name: 'Боб' }));
    expect(response.status).toBe(401);
    expect(setUserName).not.toHaveBeenCalled();
  });

  it('rejects fields other than name, so role cannot be changed here', async () => {
    const response = await PATCH(patch({ name: 'Боб', role: 'admin' }));
    expect(response.status).toBe(400);
    expect(setUserName).not.toHaveBeenCalled();
  });

  it('reports a database failure instead of a fake success', async () => {
    vi.mocked(setUserName).mockResolvedValue({ ok: false, error: 'db' });
    const response = await PATCH(patch({ name: 'Боб' }));
    expect(response.status).toBe(500);
  });
});
