import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PATCH } from './route';
import { getAuth } from '../../../../lib/auth';
import {
  getUserOnboardingCompleted,
  setUserOnboardingCompleted,
  setUserName,
} from '../../../../lib/admin-users';

vi.mock('../../../../lib/auth', () => ({ getAuth: vi.fn() }));
vi.mock('../../../../lib/admin-users', () => ({
  getUserOnboardingCompleted: vi.fn(),
  setUserOnboardingCompleted: vi.fn(),
  setUserName: vi.fn(),
}));

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
  vi.mocked(getUserOnboardingCompleted).mockResolvedValue({ ok: true, value: false });
  vi.mocked(setUserOnboardingCompleted).mockResolvedValue({
    ok: true,
    value: { onboarding_completed: true },
  });
});

describe('GET /api/me (AR-80)', () => {
  it('returns the server-side onboarding state', async () => {
    const response = await GET(new Request('http://localhost/api/me'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { name: 'Алиса', onboarding_completed: false },
    });
    expect(getUserOnboardingCompleted).toHaveBeenCalledWith('usr-42');
  });

  it('rejects a request without a session', async () => {
    vi.mocked(getAuth).mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    } as unknown as ReturnType<typeof getAuth>);
    const response = await GET(new Request('http://localhost/api/me'));
    expect(response.status).toBe(401);
    expect(getUserOnboardingCompleted).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/me (AR-74, AR-80)', () => {
  it('lets a non-admin user rename themselves', async () => {
    const response = await PATCH(patch({ name: '  Боб  ' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { name: 'Боб' } });
    expect(setUserName).toHaveBeenCalledWith('usr-42', 'Боб');
    expect(setUserOnboardingCompleted).not.toHaveBeenCalled();
  });

  it('marks onboarding complete on the server', async () => {
    const response = await PATCH(patch({ onboarding_completed: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { onboarding_completed: true },
    });
    expect(setUserOnboardingCompleted).toHaveBeenCalledWith('usr-42', true);
    expect(setUserName).not.toHaveBeenCalled();
  });

  it('saves a name and onboarding in one request', async () => {
    const response = await PATCH(patch({ name: 'Боб', onboarding_completed: true }));
    expect(response.status).toBe(200);
    expect(setUserName).toHaveBeenCalledWith('usr-42', 'Боб');
    expect(setUserOnboardingCompleted).toHaveBeenCalledWith('usr-42', true);
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

  it('rejects fields other than name and onboarding_completed', async () => {
    const response = await PATCH(patch({ name: 'Боб', role: 'admin' }));
    expect(response.status).toBe(400);
    expect(setUserName).not.toHaveBeenCalled();
    expect(setUserOnboardingCompleted).not.toHaveBeenCalled();
  });

  it('rejects an invalid onboarding flag', async () => {
    const response = await PATCH(patch({ onboarding_completed: 'yes' }));
    expect(response.status).toBe(400);
    expect(setUserOnboardingCompleted).not.toHaveBeenCalled();
  });

  it('does not allow resetting a completed onboarding', async () => {
    const response = await PATCH(patch({ onboarding_completed: false }));
    expect(response.status).toBe(400);
    expect(setUserOnboardingCompleted).not.toHaveBeenCalled();
  });

  it('reports a database failure instead of a fake success', async () => {
    vi.mocked(setUserName).mockResolvedValue({ ok: false, error: 'db' });
    const response = await PATCH(patch({ name: 'Боб' }));
    expect(response.status).toBe(500);
  });
});
