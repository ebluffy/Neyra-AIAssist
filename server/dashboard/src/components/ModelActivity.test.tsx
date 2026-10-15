import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelActivity } from './ModelActivity'

const request = vi.fn()
vi.mock('../api', async () => ({
  ...await vi.importActual('../api'),
  apiGet: (...args: unknown[]) => request(...args),
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ModelActivity polling={false} /></QueryClientProvider>)
}

describe('model evidence', () => {
  it('never substitutes the configured model for absent provider evidence', async () => {
    request.mockResolvedValue({ data: { items: [{ turn_id: 'one', timestamp: '2026-10-14T10:00:00Z', status: 'completed', without_llm: false,
      calls: [{ lane: 'talk', purpose: 'reply', attempt: 1, status: 'completed', provider: 'offline', configured_model: 'configured', reported_model: null }],
    }] } })
    show()
    expect(await screen.findByText('Не сообщена')).toBeTruthy()
    expect(screen.getByText('configured')).toBeTruthy()
    expect(screen.getByText('Сообщено провайдером')).toBeTruthy()
  })
  it('explains the empty history', async () => {
    request.mockResolvedValue({ data: { items: [] } })
    show()
    expect(await screen.findByText('Вызовов пока нет')).toBeTruthy()
  })
  it('shows an error with retry', async () => {
    request.mockRejectedValue(new Error('offline failure'))
    show()
    expect(await screen.findByText('offline failure')).toBeTruthy()
    expect(screen.getByRole('button', { name: /повторить/i })).toBeTruthy()
  })
})
