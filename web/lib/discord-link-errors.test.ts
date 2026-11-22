import { describe, expect, it } from 'vitest';
import { discordLinkErrorMessage } from './discord-link-errors';

describe('discordLinkErrorMessage', () => {
  it('maps Better Auth OAuth callback codes to Russian text', () => {
    expect(discordLinkErrorMessage('email_does_not_match')).toContain('не совпадает');
    expect(discordLinkErrorMessage('oauth_provider_not_found')).toContain('не настроен');
    expect(discordLinkErrorMessage('email_not_verified')).toContain('не подтверждён');
    expect(discordLinkErrorMessage('account_already_linked_to_different_user')).toContain('другому аккаунту');
  });

  it('normalizes case and falls back for unknown or empty codes', () => {
    expect(discordLinkErrorMessage('OAUTH_PROVIDER_NOT_FOUND')).toContain('не настроен');
    expect(discordLinkErrorMessage('something_new')).toContain('Не удалось привязать Discord');
    expect(discordLinkErrorMessage('')).toContain('Не удалось привязать Discord');
  });
});
