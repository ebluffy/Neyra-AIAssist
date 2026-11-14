import { describe, expect, it } from 'vitest';
import { isAdminRole, toAdminUser } from './admin-guard';

describe('admin page/API gate', () => {
  it('accepts only role=admin', () => {
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('user')).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole('ADMIN')).toBe(false);
  });

  it('turns a session user into an admin or nothing (404 for pages, 403 for API)', () => {
    expect(toAdminUser({ id: 'u1', email: 'a@b.co', name: 'A', role: 'admin' })).toEqual({
      id: 'u1',
      email: 'a@b.co',
      name: 'A',
      role: 'admin',
    });
    expect(toAdminUser({ id: 'u1', email: 'a@b.co', name: 'A', role: 'user' })).toBeNull();
    expect(toAdminUser({ id: 'u1', email: 'a@b.co', name: 'A' })).toBeNull();
    expect(toAdminUser(null)).toBeNull();
  });

  it('falls back to email when the name is missing', () => {
    expect(toAdminUser({ id: 'u1', email: 'a@b.co', role: 'admin' })?.name).toBe('a@b.co');
  });
});
