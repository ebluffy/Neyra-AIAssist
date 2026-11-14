import { it, expect } from 'vitest';
import { clientIp, failedLoginKey, readEmail, FAILED_LOGIN_MAX_ATTEMPTS } from './login-throttle';

it('keys failed-login counters by normalized email and IP (AR-27)', () => {
  expect(failedLoginKey('User@Example.COM', '203.0.113.7')).toBe('login-fail:user@example.com:203.0.113.7');
  expect(failedLoginKey('  a@b.co ', '198.51.100.1')).toBe('login-fail:a@b.co:198.51.100.1');
  // Другой адрес с того же email не блокирует владельца.
  expect(failedLoginKey('user@example.com', '203.0.113.7'))
    .not.toBe(failedLoginKey('user@example.com', '198.51.100.9'));
});

it('reads only the trusted edge IP header', () => {
  const request = new Request('http://localhost/', { headers: { 'x-real-ip': ' 203.0.113.7 ' } });
  expect(clientIp(request)).toBe('203.0.113.7');
  expect(clientIp(new Request('http://localhost/', { headers: { 'x-forwarded-for': '1.2.3.4' } }))).toBe('unknown');
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
