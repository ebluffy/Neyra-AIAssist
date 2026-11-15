// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WarmupSessions } from './warmup-sessions';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WarmupSessions', () => {
  it('sends a JSON content-type and an empty object on POST (AR-25)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { accepted: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WarmupSessions />);
    fireEvent.click(screen.getByRole('button', { name: 'Прогреть сессии' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/system/warmup');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe('{}');
    expect(await screen.findByText('Прогрев запущен.')).toBeTruthy();
  });
});
