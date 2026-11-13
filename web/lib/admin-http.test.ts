import { describe, expect, it } from 'vitest';
import { describeActionError, jsonError, jsonOk, readJson } from './admin-http';

describe('admin http helpers', () => {
  it('wraps success and error payloads in one shape', async () => {
    const ok = jsonOk({ id: '1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, data: { id: '1' } });

    const bad = jsonError(403, 'forbidden', 'Доступ только для администратора.');
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ ok: false, error: 'forbidden', message: 'Доступ только для администратора.' });
  });

  it('maps action errors to statuses the UI can rely on', () => {
    expect(describeActionError('self').status).toBe(409);
    expect(describeActionError('last-admin').status).toBe(409);
    expect(describeActionError('not-found').status).toBe(404);
    expect(describeActionError('db').status).toBe(500);
    expect(describeActionError('db').error).toBe('db');
  });

  it('accepts only JSON objects', async () => {
    const object = await readJson(new Request('http://x', { method: 'POST', body: '{"a":1}' }));
    expect(object).toEqual({ a: 1 });

    const array = await readJson(new Request('http://x', { method: 'POST', body: '[1,2]' }));
    expect(array).toBeNull();

    const broken = await readJson(new Request('http://x', { method: 'POST', body: 'not json' }));
    expect(broken).toBeNull();
  });
});
