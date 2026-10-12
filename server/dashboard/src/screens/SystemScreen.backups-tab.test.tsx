import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, type RouteObject } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appRoutes } from '../routes'

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

/** Pull the real element wired to a path in appRoutes (children of the shell route). */
function routeElement(path: string) {
  const shell = appRoutes.find((r) => r.path === '/') as RouteObject
  const child = shell.children?.find((c) => c.path === path)
  if (!child) throw new Error(`route not found: ${path}`)
  return child.element
}

describe('SystemScreen initialTab (AR-119)', () => {
  beforeEach(() => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/meta')) return { ok: true, data: { api_version: '1' } }
      if (path.startsWith('/v1/webhooks/dlq')) return { ok: true, data: { items: [] } }
      if (path.startsWith('/v1/backup/list')) return { ok: true, data: { archives: [] } }
      if (path.startsWith('/v1/health')) return { ok: true, data: { ok: true } }
      return { ok: true, data: {} }
    })
    apiPost.mockImplementation(async () => ({ ok: true, data: {} }))
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opens the Backup tab for the /backups route', async () => {
    render(<MemoryRouter initialEntries={['/backups']}>{routeElement('backups')}</MemoryRouter>)
    await screen.findByRole('heading', { name: 'Система' })

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Бэкап/i }).getAttribute('aria-selected')).toBe('true')
    })
    expect(screen.getByRole('button', { name: /Создать бэкап/i })).toBeTruthy()
  })

  it('follows initialTab when the route changes from /system to /backups', async () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/system']}>{routeElement('system')}</MemoryRouter>,
    )
    await screen.findByRole('heading', { name: 'Система' })
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Обзор/i }).getAttribute('aria-selected')).toBe('true')
    })

    rerender(<MemoryRouter initialEntries={['/backups']}>{routeElement('backups')}</MemoryRouter>)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Бэкап/i }).getAttribute('aria-selected')).toBe('true')
    })
  })
})
