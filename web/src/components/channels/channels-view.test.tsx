// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { resolveChatId, resolveTabKey } from '../../../lib/chat-id';
import { ChannelsView } from './channels-view';
import { ChannelsNav } from './channels-nav';
import { guilds, members, detail, messages, stats, activity } from './fixtures.test-data';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

function setup(overrides: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    let data: unknown = url.pathname.endsWith('/guilds')
      ? { items: guilds }
      : url.pathname.includes('/guilds/')
      ? detail
      : url.pathname.endsWith('/members')
      ? { items: members, total: 3 }
      : url.pathname.endsWith('/stats')
      ? stats
      : url.pathname.endsWith('/activity')
      ? activity
      : { items: messages, available: true, total: 3, next_cursor: null };

    for (const [path, replacement] of Object.entries(overrides)) {
      if (url.pathname.endsWith(path)) data = replacement;
    }
    return Response.json({ ok: true, data });
  });

  vi.stubGlobal('fetch', fetcher);
  render(<ChannelsView />);
  return fetcher;
}

async function openGuild() {
  fireEvent.click(await screen.findByRole('button', { name: /Северная станция/ }));
  await screen.findByRole('button', { name: /Вся история/ });
  await screen.findByRole('button', { name: /разговоры/ });
}

it('renders guild names and actual API counts, then member IDs without @', async () => {
  setup();
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Загрузка');
  const card = await screen.findByRole('button', { name: /Северная станция/ });
  expect(within(card).getByText('4')).toBeTruthy();
  expect(within(card).getByText('3')).toBeTruthy();

  await openGuild();
  const person = await screen.findByRole('button', { name: /Алексей/ });
  expect(person.textContent).not.toContain('@@');
  expect(person.textContent).toContain('42 сообщ.');
});

it('sorts chronology by ISO timestamp, shows Moscow time and legacy web channels, removes traces', async () => {
  const fetcher = setup();
  await openGuild();

  await screen.findByText('Нейра, с чего лучше начать наш новый проект?');
  const articles = screen.getAllByRole('article');
  expect(articles).toHaveLength(2);
  expect(articles[0].textContent).toContain('Нейра, с чего');
  expect(articles[1].textContent).toContain('Давайте начнём');
  expect(articles[0].textContent).toContain('13.11.2026, 17:45');
  expect(articles[0].textContent).toContain('100000000000000001');

  // Verify model_trace is not displayed
  expect(screen.queryByText('PRIVATE_MODEL_TRACE')).toBeNull();
  expect(screen.getAllByText('веб-чат').length).toBeGreaterThan(0);

  const call = fetcher.mock.calls.find(([url]) => url.includes('/messages'))![0];
  expect(new URL(call, 'http://local').searchParams.has('guild_id')).toBe(false);

  fireEvent.change(screen.getByLabelText('Канал'), { target: { value: 'channel-1' } });
  await waitFor(() => expect(fetcher.mock.calls.at(-1)![0]).toContain('channel_id=channel-1'));

  fireEvent.change(screen.getByLabelText('Поиск по тексту'), { target: { value: 'проект' } });
  await waitFor(() => expect(new URL(fetcher.mock.calls.at(-1)![0], 'http://local').searchParams.get('q')).toBe('проект'));
});

it('opens participant stats and applies the person history filter', async () => {
  const fetcher = setup();
  await openGuild();

  const alexButton = await screen.findByRole('button', { name: /Алексей/ });
  fireEvent.click(alexButton);

  const drawer = screen.getByRole('dialog');
  await within(drawer).findByText('42');
  expect(within(drawer).getByText('18')).toBeTruthy();
  expect(within(drawer).getByText('person-1')).toBeTruthy();
  expect(within(drawer).getByRole('img').getAttribute('aria-label')).toContain('2026-11-13: 9');

  fireEvent.click(within(drawer).getByRole('button', { name: 'Показать историю' }));
  await waitFor(() => expect(fetcher.mock.calls.at(-1)![0]).toContain('person_id=person-1'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect((screen.getByLabelText('Человек') as HTMLSelectElement).value).toBe('person-1');
});

it('shows empty history as a normal state and unavailable memory without invented counts', async () => {
  setup({ '/messages': { items: [], available: true } });
  await openGuild();
  await screen.findByText('Сообщений пока нет');
  expect(screen.queryByRole('alert')).toBeNull();

  cleanup();
  setup({ '/stats': { available: false } });
  await openGuild();
  fireEvent.click(await screen.findByRole('button', { name: /Алексей/ }));
  await screen.findByText('Хаб памяти недоступен');
  expect(screen.queryByText('сообщений всего')).toBeNull();
});

it('shows a fetch error with retry, then an empty guild list', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('Нет соединения с ядром.'))
    .mockResolvedValue(Response.json({ ok: true, data: { items: [] } }));
  vi.stubGlobal('fetch', fetcher);
  render(<ChannelsView />);

  expect((await screen.findByRole('alert')).textContent).toContain('Нет соединения с сервером.');
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await screen.findByText('Серверов пока нет');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('hides channels navigation from users, including the compact rail', () => {
  const user = render(<ChannelsNav role="user" />);
  expect(screen.queryByRole('button', { name: 'Каналы' })).toBeNull();
  user.rerender(<ChannelsNav role="admin" compact />);
  fireEvent.click(screen.getByRole('button', { name: 'Каналы' }));
  expect(push).toHaveBeenCalledWith('/channels');
});

it('loads older message pages, deduplicates IDs, keeps chronological order and resets on filters', async () => {
  const fetcher = setup({
    '/messages': { items: messages, available: true, total: 3, next_cursor: 2 },
  });
  await openGuild();

  fetcher.mockImplementation(async (input: string) => {
    const url = new URL(input, 'http://local');
    if (!url.pathname.endsWith('/messages')) return Response.json({ ok: true, data: { items: members } });
    return Response.json({
      ok: true,
      data: url.searchParams.has('cursor')
        ? { items: [messages[1], { ...messages[1], id: 0, ts: '2026-11-01T10:00:00Z', text: 'Старое сообщение' }], available: true, next_cursor: null }
        : { items: messages, available: true, next_cursor: 2 },
    });
  });

  fireEvent.click(await screen.findByRole('button', { name: 'Загрузить ещё' }));
  await screen.findByText('Старое сообщение');

  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(screen.getAllByRole('article')[0].textContent).toContain('Старое сообщение');

  fireEvent.change(screen.getByLabelText('Человек'), { target: { value: 'person-1' } });
  await waitFor(() => expect(screen.queryByText('Старое сообщение')).toBeNull());
  expect(new URL(fetcher.mock.calls.at(-1)![0], 'http://local').searchParams.has('cursor')).toBe(false);
});

it('paginates guilds without dropping the first page', async () => {
  const first = Array.from({ length: 200 }, (_, index) => ({
    ...guilds[0],
    id: `g-${index}`,
    name: `Сервер ${index}`,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      Response.json({
        ok: true,
        data: {
          items: new URL(input, 'http://local').searchParams.get('offset') === '200'
            ? [{ ...guilds[0], id: 'last', name: 'Последний сервер' }]
            : first,
          total: 201,
        },
      })
    )
  );

  render(<ChannelsView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Загрузить серверы' }));
  await screen.findByText('Последний сервер', {}, { timeout: 5000 });
  expect(screen.getByRole('button', { name: /Сервер 0/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Загрузить серверы' })).toBeNull();
});

it('starts a new personal chat from the app sidebar in the current user scope', async () => {
  const tab = resolveTabKey(window);
  const before = resolveChatId(sessionStorage, tab, 'admin-id');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: { items: [] } })));

  render(<ChannelsView userId="admin-id" />);
  fireEvent.click(screen.getByRole('button', { name: 'Новый чат' }));
  expect(resolveChatId(sessionStorage, tab, 'admin-id')).not.toBe(before);
  expect(push).toHaveBeenCalledWith('/chat');
  sessionStorage.clear();
});

it('filters out empty channels and displays only channels with messages from activity', async () => {
  setup();
  await openGuild();

  // channel-1 has 26 messages in activity, web:old-chat has 16 messages
  // channel-2 (идеи) and channel-3 (голосовая) have 0 messages in activity
  expect(screen.getByRole('button', { name: /разговоры/ })).toBeTruthy();
  expect(screen.getByText('26 сообщ.')).toBeTruthy();

  // channel-2 (идеи) and channel-3 (голосовая) should NOT be in the channel list
  expect(screen.queryByRole('button', { name: /идеи/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /голосовая/ })).toBeNull();
});

it('orders members in right panel: people who wrote to Neyra first, then others', async () => {
  setup();
  await openGuild();

  // Section "Писали Нейре" has Alex (42 messages)
  const wroteSection = screen.getByText(/Писали Нейре — 1/);
  expect(wroteSection).toBeTruthy();

  // Section "Остальные участники" has Maria and Neyra
  const otherSection = screen.getByText(/Остальные участники — 2/);
  expect(otherSection).toBeTruthy();
});

it('supports mode switching between turn blocks and chronological stream', async () => {
  setup();
  await openGuild();

  // Mode tablist exists
  const turnsTab = screen.getByRole('tab', { name: 'По диалогам' });
  const chronoTab = screen.getByRole('tab', { name: 'Хронологически' });
  expect(turnsTab).toBeTruthy();
  expect(chronoTab).toBeTruthy();

  // Default is 'turns' on All history
  expect(turnsTab.getAttribute('aria-selected')).toBe('true');

  // Switch to chronological
  fireEvent.click(chronoTab);
  expect(chronoTab.getAttribute('aria-selected')).toBe('true');

  // Switch back to turns
  fireEvent.click(turnsTab);
  expect(turnsTab.getAttribute('aria-selected')).toBe('true');
});
