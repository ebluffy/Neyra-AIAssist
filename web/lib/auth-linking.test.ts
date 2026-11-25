import { describe, expect, it } from 'vitest';
import { ACCOUNT_LINKING, discordProfileUser, normalizeNewUser } from './auth';

// Регрессия AR-18: раньше Discord был trustedProviders, и чужой Discord с тем же
// (неподтверждённым) email привязывался к существующему аккаунту.
// AR-202: явная привязка должна разрешать другой email, но не перезаписывать профиль.
describe('OAuth account linking policy', () => {
  it('не считает Discord доверенным провайдером и требует подтверждённый email', () => {
    expect(ACCOUNT_LINKING).not.toHaveProperty('trustedProviders');
    expect(ACCOUNT_LINKING.enabled).toBe(true);
    expect(ACCOUNT_LINKING.requireLocalEmailVerified).toBe(true);
  });

  it('разрешает linkSocial с другим email и подтягивает ник Discord в профиль', () => {
    expect(ACCOUNT_LINKING.allowDifferentEmails).toBe(true);
    expect(ACCOUNT_LINKING.updateUserInfoOnLink).toBe(true);
    expect(ACCOUNT_LINKING).not.toHaveProperty('disableImplicitLinking');
  });

  it('берёт имя Discord из global_name или username', () => {
    expect(discordProfileUser({ id: '1', username: 'ebluffy' })).toEqual({
      email: '1@discord.placeholder.invalid',
      name: 'ebluffy',
    });
    expect(discordProfileUser({ id: '2', email: 'd@example.test', username: 'old', global_name: 'Dima' })).toEqual({
      email: 'd@example.test',
      name: 'Dima',
    });
  });

  it('нормализует имя при создании пользователя', () => {
    expect(normalizeNewUser({ email: 'dima2_05@mail.ru', name: 'dima2_05@mail.ru' }).name).toBe('dima2_05');
    expect(normalizeNewUser({ email: 'dima2_05@mail.ru', name: 'ebluffy' }).name).toBe('ebluffy');
    expect(normalizeNewUser({ id: 'abcdef123456', email: '', name: '' }).name).toBe('abcdef12');
    expect(normalizeNewUser({ email: 'a@b.co', name: 'x'.repeat(500) }).name).toHaveLength(64);
  });
});
