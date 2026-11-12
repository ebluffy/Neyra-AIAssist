import { it, expect } from 'vitest';
import { readDatabaseUrl, readAuthEnv } from './env';
it('reports missing database URL without leaking values', () => { expect(() => readDatabaseUrl({})).toThrow('Не задана DATABASE_URL'); });
it('accepts PostgreSQL and rejects other protocols', () => { expect(readDatabaseUrl({ DATABASE_URL: 'postgresql://localhost/test' })).toBe('postgresql://localhost/test'); expect(() => readDatabaseUrl({DATABASE_URL:'https://localhost'})).toThrow('PostgreSQL URL'); });
it('requires secret and public origin only at runtime', () => {
 expect(() => readAuthEnv({DATABASE_URL:'postgres://localhost/test'})).toThrow('BETTER_AUTH_SECRET');
 expect(() => readAuthEnv({DATABASE_URL:'postgres://localhost/test',BETTER_AUTH_SECRET:'x'.repeat(32),BETTER_AUTH_URL:'https://example.test/path'})).toThrow('BETTER_AUTH_URL');
 expect(readAuthEnv({DATABASE_URL:'postgres://localhost/test',BETTER_AUTH_SECRET:'x'.repeat(32),BETTER_AUTH_URL:'https://example.test'}).baseURL).toBe('https://example.test');
});
