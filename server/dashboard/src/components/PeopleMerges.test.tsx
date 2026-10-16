import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeopleMerges } from './PeopleMerges'

afterEach(cleanup)
const people = [{ id: 'a', names: ['Alice'] }, { id: 'b', names: ['Bob'] }]
const callbacks = () => ({ busy: false, onApply: vi.fn(), onReject: vi.fn(async () => {}), onUndo: vi.fn(), onRefresh: vi.fn() })

describe('PeopleMerges', () => {
  it('has clear empty and filtered-empty states', async () => {
    render(<PeopleMerges proposals={[]} history={[]} people={people} {...callbacks()} />)
    expect(screen.getByText('Нет предложений объединения')).toBeTruthy()
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Поиск объединений' }), 'missing')
    expect(screen.getByText('Совпадений нет')).toBeTruthy()
  })
  it('shows names, direction, details and separate apply/reject actions', async () => {
    const cb = callbacks()
    render(<PeopleMerges proposals={[{ id: 1, person_a: 'a', person_b: 'b', reason: 'same account evidence' }]} history={[]} people={people} {...cb} />)
    expect(screen.getByRole('heading', { name: 'Bob → Alice' })).toBeTruthy()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Объединить карточки' }))
    expect(cb.onApply).toHaveBeenCalledWith(1)
    await user.click(screen.getByRole('button', { name: 'Отклонить предложение' }))
    expect(cb.onReject).toHaveBeenCalledWith(1)
  })
  it('keeps undone history visible and disables undo for it', async () => {
    const cb = callbacks()
    render(<PeopleMerges proposals={[]} history={[{ id: 1, survivor_id: 'a', source_id: 'removed', source_label: 'Historical Bob' }, { id: 2, survivor_id: 'a', source_id: 'b', undone_at: '2026-10-18T12:00:00Z' }]} people={people} {...cb} />)
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Список объединений' }), 'history')
    expect(screen.getByRole('heading', { name: 'Historical Bob → Alice' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Отменить объединение #2' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Отменить объединение #1' }))
    expect(cb.onUndo).toHaveBeenCalledWith(1)
  })
  it('paginates and searches beyond the first page', async () => {
    const proposals = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, person_a: 'a', person_b: `source-${i}`, reason: `evidence-${i}` }))
    render(<PeopleMerges proposals={proposals} history={[]} people={people} {...callbacks()} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByText('Страница 2 из 3')).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: 'Поиск объединений' }), 'evidence-20')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'source-20 → Alice' })).toBeTruthy()
  })
})
