const MESSAGES: Record<string, string> = {
  oauth_provider_not_found: 'Discord не настроен на сервере.',
  email_does_not_match: 'Email Discord не совпадает с email аккаунта.',
  email_not_verified: 'Email в Discord не подтверждён.',
  account_already_linked_to_different_user: 'Этот Discord уже привязан к другому аккаунту.',
  unable_to_link_account: 'Не удалось привязать Discord к аккаунту.',
  social_account_already_linked: 'Discord уже привязан к этому аккаунту.',
  linking_not_allowed: 'Привязка этого аккаунта запрещена.',
  access_denied: 'Доступ к Discord отменён.',
};

export function discordLinkErrorMessage(code: string | null | undefined): string {
  const key = String(code || '').trim().toLowerCase();
  return MESSAGES[key] || 'Не удалось привязать Discord. Попробуйте ещё раз.';
}
