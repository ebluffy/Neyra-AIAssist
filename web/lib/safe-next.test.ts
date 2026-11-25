import { describe, expect, it } from 'vitest';
import { sanitizeNextPath } from './safe-next';

describe('sanitizeNextPath', () => {
  it('keeps same-origin relative paths', () => {
    expect(sanitizeNextPath('/share/abc')).toBe('/share/abc');
    expect(sanitizeNextPath('/chat?thread=1#top')).toBe('/chat?thread=1#top');
    expect(sanitizeNextPath('/')).toBe('/');
    expect(sanitizeNextPath('http://neyra.local/chat')).toBe('/chat');
  });

  it('rejects absolute, protocol-relative and control-character tricks', () => {
    for (const value of [
      '//evil.example',
      '/\\t/evil.example',
      '/%09/evil.example',
      '/\n/evil.example',
      '\\\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
    ]) {
      expect(sanitizeNextPath(value)).toBeUndefined();
    }
  });

  it('rejects empty and control-only values', () => {
    expect(sanitizeNextPath(undefined)).toBeUndefined();
    expect(sanitizeNextPath('')).toBeUndefined();
    expect(sanitizeNextPath('/\u0000evil')).toBeUndefined();
  });
});
