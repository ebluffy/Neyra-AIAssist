import { describe, expect, it } from 'vitest';
import { clock, composerSlot, threadTitle } from './chat';
import { themeId } from './theme';

describe('chat composer', () => {
  it('keeps the live button until there is text', () => {
    expect(composerSlot('')).toBe('live');
    expect(composerSlot('   ')).toBe('live');
    expect(composerSlot('привет')).toBe('send');
  });
  it('names a thread from the first thing the user said', () => {
    expect(threadTitle([])).toBe('Новый чат');
    expect(threadTitle([{ role: 'user', content: '  коротко  ' }])).toBe('коротко');
    expect(threadTitle([{ role: 'user', content: 'а'.repeat(50) }])).toHaveLength(43);
  });
  it('formats a recording clock', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(9500)).toBe('0:10');
  });
});

describe('themes', () => {
  it('falls back to the Neyra theme', () => {
    expect(themeId('neyra')).toBe('neyra');
    expect(themeId('dark')).toBe('dark');
    expect(themeId('light')).toBe('light');
    expect(themeId('purple')).toBe('neyra');
    expect(themeId(undefined)).toBe('neyra');
  });
});
