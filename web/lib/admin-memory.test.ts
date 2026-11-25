import { describe, expect, it } from 'vitest';
import {
  accountLabels,
  discordLabels,
  isRawId,
  personAliases,
  personIdLabel,
  personTitle,
} from './admin-memory';

const uuid = '6f1c2a9e-3b4d-4c5e-8f90-1234567890ab';

describe('personTitle', () => {
  it('never shows a raw UUID as the name', () => {
    expect(personTitle({ id: uuid, display_name: uuid })).toBe('Без имени');
    expect(personTitle({ id: uuid, display_name: uuid, names: [uuid] })).toBe('Без имени');
  });

  it('prefers a human display name, then an alias', () => {
    expect(personTitle({ id: uuid, display_name: 'Дмитрий' })).toBe('Дмитрий');
    expect(personTitle({ id: uuid, display_name: uuid, names: [uuid, 'dmitry'] })).toBe('dmitry');
  });

  it('keeps a legacy slug id as the title once', () => {
    expect(personTitle({ id: 'ivan', display_name: 'ivan' })).toBe('ivan');
  });
});

describe('personIdLabel', () => {
  it('returns the UUID once and hides a repeated slug', () => {
    expect(personIdLabel({ id: uuid, display_name: uuid })).toBe(uuid);
    expect(personIdLabel({ id: 'ivan', display_name: 'ivan' })).toBeNull();
    expect(personIdLabel({ id: '', display_name: 'x' })).toBeNull();
  });
});

describe('personAliases', () => {
  it('drops the id, UUIDs and duplicates of the title', () => {
    expect(personAliases({ id: uuid, display_name: 'Дмитрий', names: ['Дмитрий', uuid, 'dmitry', 'dmitry'] }))
      .toEqual(['dmitry']);
  });
});

describe('accountLabels', () => {
  it('renders account objects instead of [object Object]', () => {
    expect(accountLabels([
      { platform: 'discord', platform_user_id: '123456', handle: 'dmitry' },
      { platform: 'web', platform_user_id: 'abc' },
      'legacy-string',
    ])).toEqual(['discord: dmitry', 'web: abc', 'legacy-string']);
  });

  it('dedupes and survives unknown shapes', () => {
    expect(accountLabels([
      { platform: 'discord', handle: 'x' },
      { platform: 'discord', handle: 'x' },
      {},
      null,
      42,
    ])).toEqual(['discord: x', 'аккаунт']);
    expect(accountLabels(undefined)).toEqual([]);
  });
});

describe('discordLabels', () => {
  it('dedupes and trims', () => {
    expect(discordLabels({ discord_ids: [' 1 ', '1', '', 5] })).toEqual(['1']);
  });
});

describe('isRawId', () => {
  it('recognises UUIDs only', () => {
    expect(isRawId(uuid)).toBe(true);
    expect(isRawId('ivan')).toBe(false);
  });
});
