import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CoreJournalPanel, LongMemoryPanel, ShortMemoryPanel } from './MemoryLayers'

const get = vi.fn()
const remove = vi.fn()
vi.mock('../api', async () => ({ ...await vi.importActual('../api'), apiGet: (...args: unknown[]) => get(...args), apiDelete: (...args: unknown[]) => remove(...args) }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('shows actual history with keyboard accessible disclosures and an empty state', async () => {
  get.mockResolvedValueOnce({ data: { windows: [], max_messages_per_window: 10 } })
  get.mockResolvedValueOnce({ data: { windows: [{ owner_id: 'owner', channel_id: 'channel', messages: [{ role: 'user', content: 'real-history' }] }], max_messages_per_window: 10 } })
  render(<ShortMemoryPanel />)
  expect(await screen.findByText('Контекст пока пуст')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Обновить контекст' }))
  expect(await screen.findByText('real-history')).toBeTruthy()
  expect(screen.getByText(/Собеседник owner/).tagName).toBe('SUMMARY')
})

it('recovers long memory after an API error and preserves the source', async () => {
  get.mockRejectedValueOnce(new Error('memory unavailable')).mockResolvedValueOnce({ data: { entries: [{ id: 1, person_id: 'p1', fact: 'saved fact', source: 'reflection' }] } })
  render(<LongMemoryPanel />)
  expect((await screen.findByRole('alert')).textContent).toContain('memory unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Обновить сведения' }))
  expect(await screen.findByText('saved fact')).toBeTruthy()
  expect(screen.getByText(/источник: reflection/)).toBeTruthy()
})

it('journal is read only while deletion keeps its confirmation and API error', async () => {
  get.mockResolvedValue({ data: { entries: [{ id: 9, text: 'reflection event' }] } })
  remove.mockRejectedValue(new Error('delete denied'))
  render(<CoreJournalPanel />)
  expect(await screen.findByText('reflection event')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Удалить запись журнала 9' }))
  expect(remove).not.toHaveBeenCalled()
  expect(screen.getAllByRole('button', { name: /^Удалить$/ }).at(-1)?.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'УДАЛИТЬ' } })
  fireEvent.click(screen.getAllByRole('button', { name: /^Удалить$/ }).at(-1)!)
  await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('delete denied'))
  expect(remove).toHaveBeenCalledWith('/v1/memory/journal/9')
  expect(screen.getByRole('alertdialog')).toBeTruthy()
})
