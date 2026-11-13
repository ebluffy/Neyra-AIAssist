import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistrationMode, resetRegistrationModeCache, setRegistrationMode } from './site-settings';

beforeEach(() => {
  resetRegistrationModeCache();
});

describe('getRegistrationMode', () => {
  it('reads the stored mode', async () => {
    expect(await getRegistrationMode({ reader: async () => 'open' })).toBe('open');
  });

  it('treats an unknown stored value as invite', async () => {
    expect(await getRegistrationMode({ reader: async () => 'everyone', env: {} })).toBe('invite');
  });

  it('uses the env fallback when the row is missing', async () => {
    expect(await getRegistrationMode({ reader: async () => null, env: { INVITE_REQUIRED: 'false' } })).toBe('open');
    resetRegistrationModeCache();
    expect(await getRegistrationMode({ reader: async () => null, env: {} })).toBe('invite');
  });

  it('never throws when the database is down', async () => {
    const broken = async () => { throw new Error('db down'); };
    expect(await getRegistrationMode({ reader: broken, env: {} })).toBe('invite');
    resetRegistrationModeCache();
    expect(await getRegistrationMode({ reader: broken, env: { INVITE_REQUIRED: 'false' } })).toBe('open');
  });

  it('caches for at most five seconds', async () => {
    const reader = vi.fn(async () => 'open');
    expect(await getRegistrationMode({ reader, now: 1_000 })).toBe('open');
    expect(await getRegistrationMode({ reader, now: 4_000 })).toBe('open');
    expect(reader).toHaveBeenCalledTimes(1);
    expect(await getRegistrationMode({ reader, now: 6_001 })).toBe('open');
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('skips the cache when cacheMs is zero', async () => {
    const reader = vi.fn(async () => 'invite');
    await getRegistrationMode({ reader, now: 1, cacheMs: 0 });
    await getRegistrationMode({ reader, now: 2, cacheMs: 0 });
    expect(reader).toHaveBeenCalledTimes(2);
  });
});

describe('setRegistrationMode', () => {
  it('writes the value, returns the previous mode and refreshes the cache', async () => {
    const writer = vi.fn(async () => {});
    const reader = vi.fn(async () => 'invite');
    expect(await getRegistrationMode({ reader, now: 1 })).toBe('invite');

    const result = await setRegistrationMode('closed', { writer, reader });
    expect(result).toEqual({ previous: 'invite', current: 'closed' });
    expect(writer).toHaveBeenCalledWith('closed');

    // Кэш обновлён записью: сразу отдаёт новый режим без похода в БД.
    expect(await getRegistrationMode({ reader, now: 2 })).toBe('closed');
    expect(reader).toHaveBeenCalledTimes(2); // первый get + чтение previous
  });

  it('rejects an invalid mode at runtime', async () => {
    await expect(setRegistrationMode('bogus' as never, { writer: async () => {} })).rejects.toThrow();
  });
});
