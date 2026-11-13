import { it, expect } from 'vitest';
import { failedLoginKey, readEmail, FAILED_LOGIN_MAX_ATTEMPTS } from './login-throttle';

it('keys failed-login counters by normalized email', () => {
  expect(failedLoginKey('User@Example.COM')).toBe('login-fail:user@example.com');
  expect(failedLoginKey('  a@b.co ')).toBe('login-fail:a@b.co');
  expect(failedLoginKey('User@Example.COM')).not.toBe(failedLoginKey('other@example.com'));
});

it('allows a bounded number of failures before the brake engages', () => {
  expect(FAILED_LOGIN_MAX_ATTEMPTS).toBeGreaterThan(0);
  expect(FAILED_LOGIN_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
});

it('reads the email from a cloned sign-in request body', async () => {
  const request = new Request('http://localhost/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: '  Person@Example.com ', password: 'x'.repeat(12) }),
  });
  expect(await readEmail(request)).toBe('person@example.com');
  // The original body is untouched: better-auth parses it after the hook.
  expect((await request.json()).password).toBe('x'.repeat(12));
  const empty = new Request('http://localhost/api/auth/sign-in/email', { method: 'POST', body: 'not json' });
  expect(await readEmail(empty)).toBeNull();
});
