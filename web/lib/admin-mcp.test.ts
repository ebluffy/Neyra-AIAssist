import { describe, expect, it } from 'vitest';
import {
  describeMcpError,
  localizeMcpCoreError,
  validateMcpApiBody,
} from './admin-mcp';

describe('validateMcpApiBody', () => {
  it('accepts a stdio server and keeps arguments and env', () => {
    const result = validateMcpApiBody(
      {
        name: ' filesystem ',
        transport: 'stdio',
        command: ' npx ',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
        env: { TOKEN: 'secret-value', ROOT: '/data' },
        enabled: true,
      },
      { requireName: true },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
        cwd: '',
        env: { TOKEN: 'secret-value', ROOT: '/data' },
        enabled: true,
      },
    });
  });

  it('accepts an SSE server with an HTTP(S) URL', () => {
    const result = validateMcpApiBody(
      { name: 'remote', transport: 'sse', url: 'https://mcp.example/sse', enabled: false },
      { requireName: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toBe('https://mcp.example/sse');
      expect(result.value.enabled).toBe(false);
    }
  });

  it('rejects a missing name, bad name, http transport and missing command', () => {
    expect(validateMcpApiBody({ transport: 'stdio', command: 'npx' }, { requireName: true })).toMatchObject({
      ok: false,
      field: 'name',
    });
    expect(validateMcpApiBody({ name: 'плохое имя', transport: 'stdio', command: 'npx' }, { requireName: true })).toMatchObject({
      ok: false,
      field: 'name',
    });
    expect(validateMcpApiBody({ name: 'x', transport: 'http', url: 'https://x' }, { requireName: true })).toMatchObject({
      ok: false,
      field: 'transport',
    });
    expect(validateMcpApiBody({ name: 'x', transport: 'stdio' }, { requireName: true })).toMatchObject({
      ok: false,
      field: 'command',
    });
  });

  it('rejects a URL with userinfo and a non-HTTP URL', () => {
    expect(
      validateMcpApiBody(
        { name: 'remote', transport: 'sse', url: 'https://user:pass@mcp.example/sse' },
        { requireName: true },
      ),
    ).toMatchObject({ ok: false, field: 'url' });
    expect(
      validateMcpApiBody({ name: 'remote', transport: 'sse', url: 'ftp://mcp.example/sse' }, { requireName: true }),
    ).toMatchObject({ ok: false, field: 'url' });
  });

  it('rejects bad env names, non-string values and too many args', () => {
    expect(
      validateMcpApiBody(
        { name: 'x', transport: 'stdio', command: 'npx', env: { 'BAD-NAME': 'v' } },
        { requireName: true },
      ),
    ).toMatchObject({ ok: false, field: 'env' });
    expect(
      validateMcpApiBody(
        { name: 'x', transport: 'stdio', command: 'npx', env: { OK: 42 } },
        { requireName: true },
      ),
    ).toMatchObject({ ok: false, field: 'env' });
    expect(
      validateMcpApiBody(
        { name: 'x', transport: 'stdio', command: 'npx', args: Array.from({ length: 51 }, () => 'a') },
        { requireName: true },
      ),
    ).toMatchObject({ ok: false, field: 'args' });
  });

  it('does not require name on update and never trusts a client name', () => {
    const result = validateMcpApiBody(
      { name: 'renamed', transport: 'stdio', command: 'npx' },
      { requireName: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBeUndefined();
  });

  it('keeps empty cwd so an existing working directory can be cleared', () => {
    const result = validateMcpApiBody(
      { transport: 'sse', url: 'https://mcp.example/sse', cwd: '' },
      { requireName: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cwd).toBe('');
  });
});

describe('MCP errors', () => {
  it('maps 409, 404 and 400 to human messages', () => {
    expect(describeMcpError({ state: 'error', data: null, status: 409, message: 'conflict' })).toEqual({
      status: 409,
      error: 'conflict',
      message: 'Сервер с таким именем уже есть.',
    });
    expect(describeMcpError({ state: 'error', data: null, status: 404, message: 'not found' })).toMatchObject({
      status: 404,
    });
    expect(
      describeMcpError({
        state: 'error',
        data: null,
        status: 400,
        message: 'command: обязателен для stdio.',
      }),
    ).toEqual({
      status: 400,
      error: 'invalid_mcp',
      message: 'Поле «Команда»: обязателен для stdio.',
    });
  });

  it('localizes only known field prefixes', () => {
    expect(localizeMcpCoreError('url: обязателен HTTP(S)-адрес для sse.')).toBe(
      'Поле «URL»: обязателен HTTP(S)-адрес для sse.',
    );
    expect(localizeMcpCoreError('env.TOKEN: значение должно быть строкой.')).toBe(
      'Переменная «TOKEN»: значение должно быть строкой.',
    );
    expect(localizeMcpCoreError('Не удалось записать config/modules.yaml.')).toBe(
      'Не удалось записать config/modules.yaml.',
    );
  });
});
