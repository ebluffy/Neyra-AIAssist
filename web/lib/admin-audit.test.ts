import { describe, expect, it } from 'vitest';
import { parseAuditQuery } from './admin-audit';

describe('parseAuditQuery', () => {
  it('uses defaults', () => {
    expect(parseAuditQuery({})).toEqual({ limit: 50, action: '', since: null });
  });

  it('clamps the limit and strips unsafe action characters', () => {
    const query = parseAuditQuery(new URLSearchParams('limit=5000&action=user.delete%27%3B--'));
    expect(query.limit).toBe(200);
    expect(query.action).toBe('user.delete--');
  });

  it('parses a valid since date and ignores a broken one', () => {
    expect(parseAuditQuery({ since: '2026-11-13T00:00:00.000Z' }).since?.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(parseAuditQuery({ since: 'вчера' }).since).toBeNull();
  });
});
