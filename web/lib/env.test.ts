import { it, expect } from 'vitest';
import { readDatabaseUrl, readAuthEnv, readChatEnv } from './env';
it('reports missing database URL without leaking values', () => { expect(() => readDatabaseUrl({})).toThrow('Не задана DATABASE_URL'); });
it('accepts PostgreSQL and rejects other protocols', () => { expect(readDatabaseUrl({ DATABASE_URL: 'postgresql://localhost/test' })).toBe('postgresql://localhost/test'); expect(() => readDatabaseUrl({DATABASE_URL:'https://localhost'})).toThrow('PostgreSQL URL'); });
it('requires secret and public origin only at runtime', () => {
 expect(() => readAuthEnv({DATABASE_URL:'postgres://localhost/test'})).toThrow('BETTER_AUTH_SECRET');
 expect(() => readAuthEnv({DATABASE_URL:'postgres://localhost/test',BETTER_AUTH_SECRET:'x'.repeat(32),BETTER_AUTH_URL:'https://example.test/path'})).toThrow('BETTER_AUTH_URL');
 expect(readAuthEnv({DATABASE_URL:'postgres://localhost/test',BETTER_AUTH_SECRET:'x'.repeat(32),BETTER_AUTH_URL:'https://example.test'}).baseURL).toBe('https://example.test');
});
it('reads chat environment with safe defaults', () => {
  const env = readChatEnv({});
  expect(env.wsUrl).toBe('ws://127.0.0.1:8787');
  expect(env.serviceKey).toBe('');
  expect(env.jwtSecret).toBe('');
  const custom = readChatEnv({ NEYRA_WS_URL: 'wss://core.internal:9000/', NEYRA_SERVICE_KEY: 'sk', NEYRA_IDENTITY_JWT_SECRET: 'sec' });
  expect(custom.wsUrl).toBe('wss://core.internal:9000');
  expect(custom.serviceKey).toBe('sk');
  expect(custom.jwtSecret).toBe('sec');
});

it('rejects HTTP, embedded credentials and query in core WS URL', () => {
  for (const url of ['https://core.test', 'ws://user:password@core.test', 'ws://core.test?token=x']) {
    expect(() => readChatEnv({ NEYRA_WS_URL: url })).toThrow('NEYRA_WS_URL');
  }
});
