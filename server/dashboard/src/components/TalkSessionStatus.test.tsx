import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiPost } from '../api'
import { TalkSessionStatus } from './TalkSessionStatus'

vi.mock('../api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))
const ready = { enabled: true, warmup_state: 'ready', active_sessions: 2, warmed_at: '2026-10-18T12:00:00Z' }
beforeEach(() => { vi.mocked(apiGet).mockReset(); vi.mocked(apiPost).mockReset() })
afterEach(cleanup)

describe('talk session controls', () => {
  it('exposes loading, a useful error and keyboard retry', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: ready })
    render(<TalkSessionStatus settingsDirty={false} />)
    expect(screen.getByText('Загрузка состояния сессий…')).toBeTruthy()
    expect(await screen.findByRole('alert')).toBeTruthy()
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Обновить сессии' }).focus()
    await user.keyboard('{Enter}')
    await screen.findByText(/Активных диалогов: 2/)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('keeps paid action disabled for unsaved settings and disabled mode', async () => {
    vi.mocked(apiGet).mockResolvedValue({ data: { ...ready, enabled: false, warmup_state: 'disabled' } })
    const view = render(<TalkSessionStatus settingsDirty={false} />)
    await screen.findByText(/Responses выключены/)
    expect((screen.getByRole('button', { name: 'Прогреть persona' }) as HTMLButtonElement).disabled).toBe(true)
    vi.mocked(apiGet).mockResolvedValue({ data: ready })
    view.rerender(<TalkSessionStatus settingsDirty />)
    await screen.findByText(/Сначала сохраните или отмените/)
    expect((screen.getByRole('button', { name: 'Прогреть persona' }) as HTMLButtonElement).disabled).toBe(true)
    expect(apiPost).not.toHaveBeenCalled()
  })
  it('shows a manual warmup failure without losing readiness information', async () => {
    vi.mocked(apiGet).mockResolvedValue({ data: ready })
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('provider'))
    render(<TalkSessionStatus settingsDirty={false} />)
    await screen.findByText(/Активных диалогов: 2/)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Прогреть persona' }))
    await screen.findByRole('alert')
    expect(screen.getByText(/Активных диалогов: 2/)).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Прогреть persona' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

it('ignores an older status response after a manual warmup', async () => {
  let resolveOld!: (value: unknown) => void
  vi.mocked(apiGet).mockResolvedValueOnce({ data: ready }).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
  vi.mocked(apiPost).mockResolvedValueOnce({ data: { ...ready, active_sessions: 4 } })
  render(<TalkSessionStatus settingsDirty={false} />)
  await screen.findByText(/Активных диалогов: 2/)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Обновить сессии' }))
  await user.click(screen.getByRole('button', { name: 'Прогреть persona' }))
  await screen.findByText(/Активных диалогов: 4/)
  resolveOld({ data: ready })
  await waitFor(() => expect(screen.getByText(/Активных диалогов: 4/)).toBeTruthy())
})
