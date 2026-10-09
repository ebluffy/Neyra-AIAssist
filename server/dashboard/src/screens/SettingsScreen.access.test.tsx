import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'

const setSessionToken = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    apiGet: vi.fn(async (path: string) => {
      if (path === '/v1/config/runtime') {
        return {
          ok: true,
          data: {
            values: { 'llm.talk_model.model': 'test-model' },
            providers: ['openrouter'],
          },
        }
      }
      return { ok: true, data: {} }
    }),
    apiPost: vi.fn(async () => ({ ok: true, data: {} })),
    setSessionToken: (...args: unknown[]) => setSessionToken(...args),
  }
})

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [{ path: '/', children: [{ path: 'settings', element: <SettingsScreen /> }] }],
    { initialEntries: ['/settings'] },
  )
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('SettingsScreen access rotate', () => {
  beforeEach(() => {
    setSessionToken.mockClear()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('blocks rotate when keys mismatch or too short without calling API', async () => {
    const user = userEvent.setup()
    renderSettings()
    await screen.findByRole('heading', { name: 'Настройки' })

    const current = screen.getByLabelText('Текущий ключ')
    const next = screen.getByLabelText('Новый ключ')
    const again = screen.getByLabelText('Повтор нового ключа')
    await user.type(current, 'a'.repeat(32))
    await user.type(next, 'b'.repeat(32))
    await user.type(again, 'c'.repeat(32))
    await user.click(screen.getByRole('button', { name: 'Сменить ключ доступа' }))
    expect(screen.getByText(/не совпадают/i)).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()

    await user.clear(again)
    await user.type(again, 'short')
    await user.clear(next)
    await user.type(next, 'short')
    await user.click(screen.getByRole('button', { name: 'Сменить ключ доступа' }))
    expect(screen.getByText(/не короче 32/i)).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stores new session token on successful rotate', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: { rotated: true, session_token: 'new-sess' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    renderSettings()
    await screen.findByRole('heading', { name: 'Настройки' })
    const key = 'k'.repeat(32)
    await user.type(screen.getByLabelText('Текущий ключ'), key)
    await user.type(screen.getByLabelText('Новый ключ'), key)
    await user.type(screen.getByLabelText('Повтор нового ключа'), key)
    await user.click(screen.getByRole('button', { name: 'Сменить ключ доступа' }))
    await waitFor(() => expect(setSessionToken).toHaveBeenCalledWith('new-sess'))
    expect(screen.getByText(/Ключ доступа сменён/i)).toBeTruthy()
  })
})
