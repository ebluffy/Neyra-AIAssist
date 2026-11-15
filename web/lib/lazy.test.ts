import { it, expect, vi } from 'vitest';
it('imports database/auth/route without env, pool creation, or connections', async () => {
 vi.resetModules();
 const pool = vi.fn();
 vi.doMock('pg', () => ({ Pool: pool }));
 vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('BETTER_AUTH_SECRET', ''); vi.stubEnv('BETTER_AUTH_URL', '');
 try {
  const { getDatabase } = await import('./db');
  const { getAuth } = await import('./auth');
  const authRoute = await import('../src/app/api/auth/[...all]/route');
  const chatRoute = await import('../src/app/api/chat/route');
  expect(authRoute.GET).toBeTypeOf('function');
  expect(chatRoute.POST).toBeTypeOf('function');
  expect(pool).not.toHaveBeenCalled();
  expect(() => getDatabase()).toThrow('DATABASE_URL'); expect(() => getAuth()).toThrow('DATABASE_URL');
  expect(pool).not.toHaveBeenCalled();
 } finally { vi.unstubAllEnvs(); vi.doUnmock('pg'); vi.resetModules(); }
});
