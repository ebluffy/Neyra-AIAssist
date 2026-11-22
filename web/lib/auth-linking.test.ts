import { describe, expect, it } from 'vitest';
import { ACCOUNT_LINKING } from './auth';

// Регрессия AR-18: раньше Discord был trustedProviders, и чужой Discord с тем же
// (неподтверждённым) email привязывался к существующему аккаунту.
// AR-202: явная привязка должна разрешать другой email, но не перезаписывать профиль.
describe('OAuth account linking policy', () => {
  it('не считает Discord доверенным провайдером и требует подтверждённый email', () => {
    expect(ACCOUNT_LINKING).not.toHaveProperty('trustedProviders');
    expect(ACCOUNT_LINKING.enabled).toBe(true);
    expect(ACCOUNT_LINKING.requireLocalEmailVerified).toBe(true);
  });

  it('разрешает linkSocial с другим email, но не перезаписывает профиль', () => {
    expect(ACCOUNT_LINKING.allowDifferentEmails).toBe(true);
    expect(ACCOUNT_LINKING).not.toHaveProperty('updateUserInfoOnLink');
    expect(ACCOUNT_LINKING).not.toHaveProperty('disableImplicitLinking');
  });
});
