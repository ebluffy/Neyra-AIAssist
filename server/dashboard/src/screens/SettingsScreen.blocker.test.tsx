import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'

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
    getStoredApiToken: () => '',
    setToken: vi.fn(),
  }
})

function renderApp(opts?: { initialEntries?: string[]; initialIndex?: number }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/',
        children: [
          { path: 'settings', element: <SettingsScreen /> },
          { path: 'status', element: <div>STATUS_OK</div> },
        ],
      },
    ],
    {
      initialEntries: opts?.initialEntries ?? ['/settings'],
      initialIndex: opts?.initialIndex,
    },
  )
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('SettingsScreen useBlocker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('asks before leave, cancel keeps dirty value, leave proceeds once', async () => {
    const user = userEvent.setup()
    const router = renderApp()
    await screen.findByRole('heading', { name: 'Настройки' })

    const input = screen.getByLabelText(/Модель речи/i)
    await user.clear(input)
    await user.type(input, 'dirty-model')

    await router.navigate('/status')
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect((input as HTMLInputElement).value).toBe('dirty-model')

    await router.navigate('/status')
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: 'Уйти' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/status'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('STATUS_OK')).toBeTruthy()

    await router.navigate('/settings')
    await screen.findByRole('heading', { name: 'Настройки' })
    const input2 = screen.getByLabelText(/Модель речи/i)
    await user.clear(input2)
    await user.type(input2, 'again-dirty')
    await router.navigate('/status')
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect((input2 as HTMLInputElement).value).toBe('again-dirty')
  })

  it('POP back: cancel keeps dirty; leave goes to previous route once', async () => {
    const user = userEvent.setup()
    const router = renderApp({ initialEntries: ['/status', '/settings'], initialIndex: 1 })
    await screen.findByRole('heading', { name: 'Настройки' })

    const input = screen.getByLabelText(/Модель речи/i)
    await user.clear(input)
    await user.type(input, 'pop-dirty')

    await router.navigate(-1)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect((input as HTMLInputElement).value).toBe('pop-dirty')

    await router.navigate(-1)
    await screen.findByRole('alertdialog')
    await user.click(screen.getByRole('button', { name: 'Уйти' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/status'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('STATUS_OK')).toBeTruthy()
  })
})
