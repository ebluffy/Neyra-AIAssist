import { describe, expect, it } from 'vitest';
import {
  checkDelete,
  checkRoleChange,
  inviteState,
  normalizeInviteTtl,
  normalizeSearch,
  pageCount,
  pageOffset,
  parseInviteListQuery,
  parseUserListQuery,
} from './admin-rules';

describe('parseUserListQuery', () => {
  it('uses safe defaults for an empty query', () => {
    expect(parseUserListQuery({})).toEqual({ q: '', page: 1, pageSize: 20, role: 'all', status: 'all' });
  });

  it('accepts URLSearchParams and known filters', () => {
    const query = parseUserListQuery(new URLSearchParams('q=%D0%B8%D0%B2%D0%B0%D0%BD&page=3&pageSize=50&role=admin&status=banned'));
    expect(query).toEqual({ q: 'иван', page: 3, pageSize: 50, role: 'admin', status: 'banned' });
  });

  it('ignores unknown filters and clamps page size', () => {
    const query = parseUserListQuery({ role: 'owner', status: 'deleted', pageSize: '10000', page: '-4' });
    expect(query.role).toBe('all');
    expect(query.status).toBe('all');
    expect(query.pageSize).toBe(100);
    expect(query.page).toBe(1);
  });
});

describe('normalizeSearch', () => {
  it('strips LIKE wildcards so search cannot match everything', () => {
    expect(normalizeSearch('%_\\')).toBe('');
    expect(normalizeSearch('  a%b_c  ')).toBe('a b c');
    expect(normalizeSearch('иван')).toBe('иван');
  });

  it('caps very long queries', () => {
    expect(normalizeSearch('x'.repeat(500)).length).toBe(120);
  });
});

describe('pagination', () => {
  it('computes offsets and page counts', () => {
    expect(pageOffset(1, 20)).toBe(0);
    expect(pageOffset(3, 20)).toBe(40);
    expect(pageOffset(0, 20)).toBe(0);
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(21, 20)).toBe(2);
    expect(pageCount(20, 20)).toBe(1);
  });
});

describe('admin safety rules', () => {
  it('forbids removing your own admin role', () => {
    expect(checkRoleChange('me', { id: 'me', role: 'admin' }, 'user', 5)).toBe('self');
    expect(checkRoleChange('me', { id: 'me', role: 'admin' }, 'admin', 5)).toBeNull();
  });

  it('forbids demoting the last admin', () => {
    expect(checkRoleChange('me', { id: 'other', role: 'admin' }, 'user', 1)).toBe('last-admin');
    expect(checkRoleChange('me', { id: 'other', role: 'admin' }, 'user', 2)).toBeNull();
  });

  it('forbids deleting yourself and the last admin', () => {
    expect(checkDelete('me', { id: 'me', role: 'admin' }, 3)).toBe('self');
    expect(checkDelete('me', { id: 'other', role: 'admin' }, 1)).toBe('last-admin');
    expect(checkDelete('me', { id: 'other', role: 'user' }, 1)).toBeNull();
  });
});

describe('invites', () => {
  it('validates TTL between 1 and 720 hours', () => {
    expect(normalizeInviteTtl(24)).toBe(24);
    expect(normalizeInviteTtl('1.5')).toBe(1.5);
    expect(normalizeInviteTtl(0)).toBeNull();
    expect(normalizeInviteTtl(721)).toBeNull();
    expect(normalizeInviteTtl('nope')).toBeNull();
  });

  it('derives the invite state in one place', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(inviteState({ usedAt: null, revokedAt: null, expiresAt: '2026-11-14T12:00:00Z' }, now)).toBe('active');
    expect(inviteState({ usedAt: null, revokedAt: null, expiresAt: '2026-11-12T12:00:00Z' }, now)).toBe('expired');
    expect(inviteState({ usedAt: '2026-11-13T10:00:00Z', revokedAt: null, expiresAt: '2026-11-14T12:00:00Z' }, now)).toBe('used');
    expect(inviteState({ usedAt: null, revokedAt: '2026-11-13T10:00:00Z', expiresAt: '2026-11-14T12:00:00Z' }, now)).toBe('revoked');
  });

  it('parses invite list filters', () => {
    expect(parseInviteListQuery({ state: 'used', page: '2' })).toEqual({ page: 2, pageSize: 20, state: 'used' });
    expect(parseInviteListQuery({ state: 'bogus' }).state).toBe('all');
  });
});
