import { describe, expect, it } from 'vitest';
import { cleanDisplayName, defaultDisplayName, emailLocalPart, isEmailLike } from './display-name';

describe('display-name', () => {
  it('uses the email local part instead of the full address', () => {
    expect(emailLocalPart('dima2_05@mail.ru')).toBe('dima2_05');
    expect(defaultDisplayName('dima2_05@mail.ru', 'dima2_05@mail.ru')).toBe('dima2_05');
    expect(defaultDisplayName('dima2_05@mail.ru')).toBe('dima2_05');
  });

  it('keeps an explicit nickname, including a Discord one', () => {
    expect(defaultDisplayName('dima2_05@mail.ru', 'ebluffy')).toBe('ebluffy');
    expect(defaultDisplayName('dima2_05@mail.ru', '  ebluffy  ')).toBe('ebluffy');
  });

  it('never returns an email as the display name', () => {
    expect(defaultDisplayName('a@b.co', 'other@example.test')).toBe('a');
    expect(defaultDisplayName('', '')).toBe('');
    expect(isEmailLike('a@b.co')).toBe(true);
    expect(isEmailLike('dima2_05')).toBe(false);
    expect(cleanDisplayName(' Боб\nИван\u0000 ')).toBe('Боб Иван');
  });
});
