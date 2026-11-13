import { describe, expect, it } from 'vitest';
import { channelLabel, cleanMessageText } from './data';

describe('history formatting', () => {
  it('strips the core author prefix and keeps the message', () => {
    expect(cleanMessageText('[author_id: 328884003958423552] [Пользователь ebluffy]: Привет')).toBe('Привет');
    expect(cleanMessageText('[author_id: 1] текст')).toBe('текст');
  });

  it('keeps plain text and does not return an empty message', () => {
    expect(cleanMessageText('Привет')).toBe('Привет');
    expect(cleanMessageText('[author_id: 1]')).toBe('[author_id: 1]');
  });

  it('labels web sessions instead of raw session ids', () => {
    expect(channelLabel('web:abc:def')).toBe('веб-чат');
    expect(channelLabel('1498032547970683112')).toBe('1498032547970683112');
    expect(channelLabel(null)).toBe('Канал неизвестен');
  });
});
