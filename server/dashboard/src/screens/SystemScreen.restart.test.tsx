import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemScreen } from './SystemScreen'

const apiGet = vi.fn()
const apiPost = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    apiGet: (...args: unknown[]) => apiGet(...args),
    apiPost: (...args: unknown[]) => apiPost(...args),
  }
})

vi.mock('../lib/wait-for-core-restart', () => ({
  waitForCoreRestart: vi.fn(async () => 'online' as const),
}))

describe('SystemScreen restart feedback', () => {
  beforeEach(() => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/meta')) return { ok: true, data: { api_version: '1' } }
      if (path.startsWith('/v1/webhooks/dlq')) return { ok: true, data: { items: [] } }
      if (path.startsWith('/v1/backup/list')) return { ok: true, data: { archives: [] } }
      if (path.startsWith('/v1/health')) return { ok: true, data: { ok: true } }
      return { ok: true, data: {} }
    })
    apiPost.mockImplementation(async (path: string) => {
      if (path === '/v1/system/restart') return { ok: true, data: {} }
      if (path === '/v1/backup/run') return { ok: true, data: {} }
      return { ok: true, data: {} }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('dismisses restart card on backup so status feedback is visible', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <SystemScreen />
      </MemoryRouter>,
    )
    await screen.findByRole('heading', { name: 'Система' })

    await user.click(screen.getByRole('button', { name: /Мягкий рестарт/i }))
    const phrase = await screen.findByLabelText(/Введите/i)
    await user.clear(phrase)
    await user.type(phrase, 'РЕСТАРТ')
    await user.click(screen.getByRole('button', { name: 'Перезапустить' }))

    await waitFor(() => {
      expect(screen.getByText(/Сервер снова онлайн/i)).toBeTruthy()
    })

    await user.click(screen.getByRole('tab', { name: /Бэкап/i }))
    await user.click(screen.getByRole('button', { name: /Создать бэкап/i }))

    await waitFor(() => {
      expect(screen.getByText('Бэкап создан.')).toBeTruthy()
    })
    expect(screen.queryByText(/Сервер снова онлайн/i)).toBeNull()
  })
})
