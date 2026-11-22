const MESSAGES: Record<string, string> = {
  provider_not_found: 'Discord не настроен на сервере.',
  account_already_linked_to_different_user: 'Этот Discord уже привязан к другому аккаунту.',
  'email_doesn\'t_match': 'Email Discord не совпадает с email аккаунта.',
  email_doesnt_match: 'Email Discord не совпадает с email аккаунта.',
  unable_to_link_account: 'Не удалось привязать Discord к аккаунту.',
  social_account_already_linked: 'Discord уже привязан к этому аккаунту.',
  linking_not_allowed: 'Привязка этого аккаунта запрещена.',
  access_denied: 'Доступ к Discord отменён.',
};

export function discordLinkErrorMessage(code: string | null | undefined): string {
  const key = String(code || '').trim().toLowerCase();
  return MESSAGES[key] || 'Не удалось привязать Discord. Попробуйте ещё раз.';
}
