// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpSection } from './mcp-section';
import type { McpPayload } from '../../../lib/admin-mcp';

vi.mock('../../lib/ui-sounds', () => ({
  playButtonClickSound: vi.fn(),
}));

const payload: McpPayload = {
  enabled: true,
  servers: [
    {
      name: 'filesystem',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
      url: null,
      cwd: null,
      env: [
        { name: 'TOKEN', set: true },
        { name: 'EMPTY', set: false },
      ],
      status: 'connected',
      tools: 3,
      last_error: null,
      checked_at: '2026-11-14T10:00:00Z',
    },
    {
      name: 'remote',
      enabled: true,
      transport: 'sse',
      command: null,
      args: [],
      url: 'https://mcp.example/sse',
      cwd: null,
      env: [],
      status: 'error',
      tools: 0,
      last_error: 'connection refused',
      checked_at: '2026-11-14T10:01:00Z',
    },
  ],
};

function clone(): McpPayload {
  return JSON.parse(JSON.stringify(payload)) as McpPayload;
}

function ok(data: unknown): Response {
  return Response.json({ ok: true, data });
}

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'error', message }, { status });
}

let fetchMock: ReturnType<typeof vi.fn>;
let mutationResponse: Response | null;

beforeEach(() => {
  mutationResponse = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/admin/mcp/servers' && method === 'GET') {
      return ok(clone());
    }
    if (url === '/api/admin/mcp/reload') {
      return ok(clone());
    }
    if (method !== 'GET' && mutationResponse) {
      const response = mutationResponse;
      mutationResponse = null;
      return response;
    }
    if (method === 'DELETE') {
      const name = decodeURIComponent(url.split('/').at(-1) ?? '');
      return ok({ enabled: true, servers: clone().servers.filter((server) => server.name !== name) });
    }
    return ok(clone());
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function openCreateForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Добавить сервер' }));
}

function submitCreateForm() {
  const buttons = screen.getAllByRole('button', { name: 'Добавить сервер' });
  fireEvent.click(buttons[buttons.length - 1]);
}

describe('McpSection', () => {
  it('показывает статусы, инструменты, ошибку и только имена env', async () => {
    render(<McpSection />);

    expect((await screen.findAllByText('filesystem')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('подключён').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ошибка').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
    expect(screen.getAllByText('connection refused').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ядро работает; исправьте настройки/).length).toBeGreaterThan(0);

    expect(screen.getAllByText('TOKEN').length).toBeGreaterThan(0);
    expect(screen.getAllByText('задан').length).toBeGreaterThan(0);
    expect(screen.getAllByText('EMPTY').length).toBeGreaterThan(0);
    expect(screen.getAllByText('не задан').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/14\.11\.2026/).length).toBeGreaterThan(0);
    expect(screen.queryByDisplayValue('secret-value')).toBeNull();
  });

  it('показывает пустое состояние с объяснением', async () => {
    fetchMock.mockImplementationOnce(async () => ok({ enabled: true, servers: [] }));
    render(<McpSection />);

    expect(await screen.findByText('MCP-серверы не подключены')).toBeTruthy();
    expect(screen.getByText(/MCP даёт Нейре инструменты/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Добавить сервер' }).length).toBeGreaterThan(0);
  });

  it('валидирует обязательные поля и отправляет stdio с env', async () => {
    render(<McpSection />);
    await screen.findAllByText('filesystem');

    openCreateForm();
    submitCreateForm();
    expect((await screen.findByRole('alert')).textContent).toContain('Имя: обязательно.');

    fireEvent.change(screen.getByLabelText(/^Имя/), { target: { value: 'fs' } });
    fireEvent.change(screen.getByLabelText(/^Команда/), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText(/^Аргументы/), {
      target: { value: '-y\n@modelcontextprotocol/server-filesystem\n/data' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.change(screen.getByPlaceholderText('API_KEY'), { target: { value: 'TOKEN' } });
    fireEvent.change(screen.getByPlaceholderText('значение'), { target: { value: 's3cret' } });
    submitCreateForm();

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === '/api/admin/mcp/servers' && init?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/api/admin/mcp/servers' && init?.method === 'POST',
    );
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
      env: { TOKEN: 's3cret' },
      enabled: true,
    });
    expect(await screen.findByText(/Сервер «fs» добавлен/)).toBeTruthy();
  });

  it('показывает 409 и оставляет форму открытой', async () => {
    mutationResponse = fail(409, 'Сервер с таким именем уже есть.');
    render(<McpSection />);
    await screen.findAllByText('filesystem');

    openCreateForm();
    fireEvent.change(screen.getByLabelText(/^Имя/), { target: { value: 'filesystem' } });
    fireEvent.change(screen.getByLabelText(/^Команда/), { target: { value: 'npx' } });
    submitCreateForm();

    expect((await screen.findByRole('alert')).textContent).toContain('Сервер с таким именем уже есть.');
    expect(screen.getByText('Новый MCP-сервер')).toBeTruthy();
  });

  it('удаляет только после подтверждения', async () => {
    render(<McpSection />);
    await screen.findAllByText('remote');

    fireEvent.click(screen.getAllByRole('button', { name: 'Удалить remote' })[0]);
    expect(screen.getAllByText(/Удалить «remote» вместе с переменными окружения/).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getAllByRole('button', { name: 'Подтвердить удаление remote' })[0]);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === '/api/admin/mcp/servers/remote' && init?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/Сервер «remote» удалён/)).toBeTruthy();
  });

  it('не отправляет env при обычном сохранении и требует полного ввода при замене', async () => {
    render(<McpSection />);
    await screen.findAllByText('filesystem');

    fireEvent.click(screen.getByRole('button', { name: 'Изменить filesystem' }));
    expect(screen.getByText('Настройка «filesystem»')).toBeTruthy();
    expect(screen.getAllByText('задан').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Значение TOKEN')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === '/api/admin/mcp/servers/filesystem' && init?.method === 'PUT',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body.env).toBeUndefined();
      expect(body.name).toBeUndefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Изменить filesystem' }));
    fireEvent.click(screen.getByRole('button', { name: 'Изменить переменные' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Переменная «TOKEN»: введите значение.');

    fireEvent.change(screen.getByLabelText('Значение TOKEN'), { target: { value: 'new-token' } });
    fireEvent.change(screen.getByLabelText('Значение EMPTY'), { target: { value: 'filled' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => {
      const puts = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/api/admin/mcp/servers/filesystem' && init?.method === 'PUT',
      );
      expect(puts.length).toBe(2);
      const body = JSON.parse(String(puts[1]?.[1]?.body));
      expect(body.env).toEqual({ TOKEN: 'new-token', EMPTY: 'filled' });
    });
  });

  it('перечитывает всё и переподключает сервер', async () => {
    render(<McpSection />);
    await screen.findAllByText('filesystem');

    fireEvent.click(screen.getByRole('button', { name: 'Перечитать всё' }));
    expect(await screen.findByText(/Конфигурация MCP перечитана/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Переподключить filesystem' })[0]);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === '/api/admin/mcp/servers/filesystem/restart' && init?.method === 'POST',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/Сервер «filesystem» переподключён/)).toBeTruthy();
  });

  it('при выключенном MCP не даёт переподключать', async () => {
    fetchMock.mockImplementationOnce(async () => ok({ enabled: false, servers: clone().servers }));
    render(<McpSection />);
    await screen.findAllByText('filesystem');

    expect(screen.getByText(/MCP-клиент выключен в конфиге ядра/)).toBeTruthy();
    expect((screen.getAllByRole('button', { name: 'Переподключить filesystem' })[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
