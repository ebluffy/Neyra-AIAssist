import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateInviteToken, hashInviteToken, readInviteToken } from './invite';

it('stores only sha256 of the token', () => {
  const token = 'dGVzdC10b2tlbi0xMjM';
  expect(hashInviteToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
  expect(hashInviteToken(token)).toHaveLength(64);
  expect(hashInviteToken(token)).not.toContain(token);
  // Регистрозависимость: хэш от того же токена стабилен, от другого — иной.
  expect(hashInviteToken(token)).toBe(hashInviteToken(token));
  expect(hashInviteToken('другой')).not.toBe(hashInviteToken(token));
});

it('generates URL-safe tokens with good entropy', () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(a.length).toBeGreaterThanOrEqual(30);
  expect(a).not.toBe(b);
});

it('reads the invite token from a sign-up body', () => {
  expect(readInviteToken({ email: 'a@b.co', password: 'x'.repeat(12), invite: '  token-1 ' })).toBe('token-1');
  expect(readInviteToken({ email: 'a@b.co', invite: '' })).toBeNull();
  expect(readInviteToken({ email: 'a@b.co' })).toBeNull();
  expect(readInviteToken(null)).toBeNull();
  expect(readInviteToken('invite=token-1')).toBeNull();
});
