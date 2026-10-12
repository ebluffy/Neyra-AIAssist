import { describe, expect, it } from 'vitest'
import { pluralRu } from './plural-ru'

describe('pluralRu', () => {
  it('picks one/few/many for typical counts', () => {
    expect(pluralRu(1, 'поле', 'поля', 'полей')).toBe('поле')
    expect(pluralRu(2, 'поле', 'поля', 'полей')).toBe('поля')
    expect(pluralRu(5, 'поле', 'поля', 'полей')).toBe('полей')
    expect(pluralRu(11, 'поле', 'поля', 'полей')).toBe('полей')
    expect(pluralRu(21, 'поле', 'поля', 'полей')).toBe('поле')
    expect(pluralRu(22, 'поле', 'поля', 'полей')).toBe('поля')
    expect(pluralRu(25, 'поле', 'поля', 'полей')).toBe('полей')
  })
})
