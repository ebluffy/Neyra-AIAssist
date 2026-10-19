import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AffectPanel } from './AffectPanel'

const get = vi.fn()
const post = vi.fn()
vi.mock('../api', async () => ({ ...await vi.importActual('../api'), apiGet: (...args: unknown[]) => get(...args), apiPost: (...args: unknown[]) => post(...args) }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const neutral = { mood: { valence: 0, arousal: 0, label: 'calm', updated_at: null }, relation: null, as_of: '2026-01-01' }

it('shows neutral state, an empty people list, and recovers after read errors', async () => {
  get.mockRejectedValueOnce(new Error('state unavailable')).mockResolvedValueOnce({ data: neutral })
  render(<AffectPanel people={[]} />)
  expect((await screen.findByRole('alert')).textContent).toContain('state unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Обновить состояние' }))
  expect(await screen.findByText('Пока нет завершённых ходов. Настроение нейтральное.')).toBeTruthy()
  expect(screen.getByText(/Список людей пока пуст/)).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'Отношение к человеку' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Сбросить выбранное отношение' }).hasAttribute('disabled')).toBe(true)
})

it('requires confirmation and keeps an API error and retry inside the reset dialog', async () => {
  get.mockResolvedValue({ data: neutral })
  post.mockRejectedValueOnce(new Error('backup unavailable')).mockResolvedValueOnce({ data: { backup: 'temporary.db' } })
  render(<AffectPanel people={[]} />)
  await screen.findByText('Спокойная')
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить настроение' }))
  expect(post).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /^Сбросить$/ }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'СБРОСИТЬ' } })
  fireEvent.click(screen.getByRole('button', { name: /^Сбросить$/ }))
  await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('backup unavailable'))
  fireEvent.click(screen.getByRole('button', { name: /^Сбросить$/ }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(post).toHaveBeenLastCalledWith('/v1/memory/affect/reset', { scope: 'mood', person_id: undefined, confirm: 'WIPE' })
  expect(screen.getByText(/сброшено.*резервная копия/)).toBeTruthy()
})

it('cancel never writes state', async () => {
  get.mockResolvedValue({ data: neutral })
  render(<AffectPanel people={[]} />)
  await screen.findByText('Спокойная')
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить все отношения' }))
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(post).not.toHaveBeenCalled()
})
