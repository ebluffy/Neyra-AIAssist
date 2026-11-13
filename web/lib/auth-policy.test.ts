import { describe, expect, it } from 'vitest';
import { authErrorText, credentialsSchema, inviteCodeSchema, roleField } from './auth-policy';
import { parseUserInput } from 'better-auth/db';
import { DEFAULT_ROLE } from '../db/schema';

it('validates email and password without altering passwords', () => {
 expect(credentialsSchema.safeParse({email:'bad',password:'1234567890'}).success).toBe(false);
 expect(credentialsSchema.safeParse({email:'a@example.test',password:'short'}).success).toBe(false);
 expect(credentialsSchema.parse({email:' a@example.test ',password:'1234567890'})).toEqual({email:'a@example.test',password:'1234567890'});
});
it('defaults new accounts to user and denies role input', () => { expect(roleField.defaultValue).toBe(DEFAULT_ROLE); expect(roleField.input).toBe(false); expect(credentialsSchema.parse({email:'a@example.test',password:'1234567890',role:'admin'})).not.toHaveProperty('role'); });
it('maps auth errors to Russian without exposing server messages', () => {
  expect(authErrorText('INVALID_EMAIL_OR_PASSWORD')).toBe('Неверный email или пароль.');
  expect(authErrorText('TOO_MANY_REQUESTS')).toBe('Слишком много попыток. Попробуйте через 15 минут.');
  expect(authErrorText('RATE_LIMITED')).toBe('Слишком много попыток. Попробуйте через 15 минут.');
  expect(authErrorText('INVALID_INVITE_CODE')).toBe('Недействительный или уже использованный код приглашения.');
  expect(authErrorText('SQL_SECRET')).toBe('Не удалось выполнить запрос. Попробуйте позже.');
  expect(authErrorText('INVITE_EXPIRED', 'Срок действия приглашения истёк.')).toBe('Срок действия приглашения истёк.');
});

it('validates invite code format', () => {
  expect(inviteCodeSchema.safeParse('123').success).toBe(false);
  expect(inviteCodeSchema.safeParse('   ').success).toBe(false);
  expect(inviteCodeSchema.parse(' NEYRA-2026 ')).toBe('NEYRA-2026');
});

it('Better Auth production parser overwrites injected admin at registration', () => {
 const options = { user: { additionalFields: { role: roleField } } };
 expect(parseUserInput(options, {role:'admin'}, 'create').role).toBe('user');
 expect(parseUserInput(options, {}, 'create').role).toBe('user');
 expect(() => parseUserInput(options, {role:'admin'}, 'update')).toThrow('role is not allowed');
});
