import { describe, expect, it } from 'vitest';
import { authErrorText, credentialsSchema, readAdminEmails, resolveRole, roleField } from './auth-policy';
import { parseUserInput } from 'better-auth/db';
import { DEFAULT_ROLE } from '../db/schema';

it('validates email and password without altering passwords', () => {
 expect(credentialsSchema.safeParse({email:'bad',password:'1234567890'}).success).toBe(false);
 expect(credentialsSchema.safeParse({email:'a@example.test',password:'short'}).success).toBe(false);
 expect(credentialsSchema.parse({email:' a@example.test ',password:'1234567890'})).toEqual({email:'a@example.test',password:'1234567890'});
});
it('defaults new accounts to user and denies role input', () => { expect(roleField.defaultValue).toBe(DEFAULT_ROLE); expect(roleField.input).toBe(false); expect(credentialsSchema.parse({email:'a@example.test',password:'1234567890',role:'admin'})).not.toHaveProperty('role'); });
it('maps auth errors to Russian without exposing server messages', () => { expect(authErrorText('INVALID_EMAIL_OR_PASSWORD')).toBe('Неверный email или пароль.'); expect(authErrorText('SQL_SECRET')).toBe('Не удалось выполнить запрос. Попробуйте позже.'); });

it('Better Auth production parser overwrites injected admin at registration', () => {
 const options = { user: { additionalFields: { role: roleField } } };
 expect(parseUserInput(options, {role:'admin'}, 'create').role).toBe('user');
 expect(parseUserInput(options, {}, 'create').role).toBe('user');
 expect(() => parseUserInput(options, {role:'admin'}, 'update')).toThrow('role is not allowed');
});

describe('admin bootstrap', () => {
  it('parses a comma separated list, trims and lowercases', () => {
    expect(readAdminEmails(' Boss@Example.com , second@example.com ')).toEqual(['boss@example.com', 'second@example.com']);
  });
  it('gives admin only to listed emails', () => {
    const admins = readAdminEmails('boss@example.com');
    expect(resolveRole('BOSS@example.com', admins)).toBe('admin');
    expect(resolveRole('someone@example.com', admins)).toBe('user');
    expect(resolveRole('boss@example.com', [])).toBe('user');
  });
});
