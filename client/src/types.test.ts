import { describe, expect, it } from 'vitest';
import { validServerUrl, formatError, newProfile, absolutePath } from './types';
describe('allowed folders', () => {
  it('accepts only absolute paths', () => { expect(absolutePath('/home/me/Docs')).toBe(true); expect(absolutePath('C:\\Users\\me')).toBe(true); for (const v of ['Docs', '~/Docs', '..\\x', '']) expect(absolutePath(v)).toBe(false); });
});
describe('server profiles', () => {
  it('rejects non-TLS remote servers and embedded secrets', () => { for (const value of ['http://example.com', 'https://user:password@example.com', 'https://example.com?token=x', 'file:///tmp/server']) expect(validServerUrl(value)).toBe(false); });
  it('allows local development and a proxy prefix', () => { expect(validServerUrl('http://127.0.0.1:8787')).toBe(true); expect(validServerUrl('https://neyra.example/api')).toBe(true); });
  it('creates independent private profile sessions', () => { const a = newProfile(); const b = newProfile(); expect(a.id).not.toBe(b.id); expect(a.session_id).not.toBe(b.session_id); });
  it('does not stringify internal errors', () => { expect(formatError(new Error('secret'))).not.toContain('secret'); });
});
