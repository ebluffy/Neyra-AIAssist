import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../api'
import { ModulesScreen } from './ModulesScreen'

const apiGet = vi.fn()
const apiPatch = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    apiGet: (...args: unknown[]) => apiGet(...args),
    apiPatch: (...args: unknown[]) => apiPatch(...args),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
    apiUpload: vi.fn(),
  }
})

vi.mock('sonner', () => ({ toast: { success: vi.fn(), message: vi.fn(), error: vi.fn() } }))

describe('ModulesScreen toggle error feedback', () => {
  beforeEach(() => {
    apiGet.mockImplementation(async (path: string) => {
      if (path === '/v1/plugins') {
        return {
          ok: true,
          data: {
            plugins: [{ id: 'demo', name: 'Demo', version: '1', lifecycle: 'on_demand', enabled: false }],
          },
        }
      }
      if (path.startsWith('/v1/plugins/demo/log-sources')) {
        return { ok: true, data: { sources: [] } }
      }
      if (path === '/v1/plugins/demo') {
        return {
          ok: true,
          data: {
            plugin: { id: 'demo', name: 'Demo', version: '1', lifecycle: 'on_demand', enabled: false },
            config: {},
          },
        }
      }
      return { ok: true, data: {} }
    })
    apiPatch.mockRejectedValue(new ApiRequestError('toggle failed', 500, 'internal', 't1'))
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('clears «Включаю…» when PATCH fails and shows the error', async () => {
    const user = userEvent.setup()
    render(<ModulesScreen />)
    await screen.findByText('Demo')
    const sw = await screen.findByRole('switch', { name: /Включить или выключить модуль/i })
    await user.click(sw)
    await waitFor(() => {
      expect(screen.getByText('toggle failed')).toBeTruthy()
    })
    expect(screen.queryByText('Включаю…')).toBeNull()
    expect(screen.queryByText('Выключаю…')).toBeNull()
  })
})
