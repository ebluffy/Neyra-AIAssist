import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../api'
import { StatusScreen } from './StatusScreen'

const apiGet = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    apiGet: (...args: unknown[]) => apiGet(...args),
    apiPost: vi.fn(),
  }
})

function renderStatus() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StatusScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('StatusScreen audit feed', () => {
  beforeEach(() => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/health/history')) return { ok: true, data: { hours: 24, points: [] } }
      if (path.startsWith('/v1/health')) return { ok: true, data: { ok: true, status: 'ok', uptime_seconds: 1 } }
      if (path.startsWith('/v1/llm/balance')) return { ok: true, data: {} }
      if (path.startsWith('/v1/plugins')) return { ok: true, data: { plugins: [] } }
      if (path.startsWith('/v1/llm/models')) return { ok: true, data: { roles: {} } }
      if (path.startsWith('/v1/audit/recent')) {
        throw new ApiRequestError('Forbidden', 403, 'forbidden', 't-403')
      }
      return { ok: true, data: {} }
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows role-denied copy on audit 403, not ErrorState', async () => {
    renderStatus()
    await waitFor(() => {
      expect(screen.getByText('Недоступно для роли.')).toBeTruthy()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows ErrorState on audit 500', async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/health/history')) return { ok: true, data: { hours: 24, points: [] } }
      if (path.startsWith('/v1/health')) return { ok: true, data: { ok: true, status: 'ok', uptime_seconds: 1 } }
      if (path.startsWith('/v1/llm/balance')) return { ok: true, data: {} }
      if (path.startsWith('/v1/plugins')) return { ok: true, data: { plugins: [] } }
      if (path.startsWith('/v1/llm/models')) return { ok: true, data: { roles: {} } }
      if (path.startsWith('/v1/audit/recent')) {
        throw new ApiRequestError('boom', 500, 'internal', 't-500')
      }
      return { ok: true, data: {} }
    })
    renderStatus()
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
    expect(screen.getByText('Аудит')).toBeTruthy()
    expect(screen.queryByText('Недоступно для роли.')).toBeNull()
  })
})
