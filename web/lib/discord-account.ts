import { getAuth } from './auth';

export async function getLinkedDiscordId(headers: Headers): Promise<string | null> {
  try {
    const accounts = await getAuth().api.listUserAccounts({ headers });
    return accounts.find((account) => account.providerId === 'discord')?.accountId ?? null;
  } catch {
    console.warn('discord_account_lookup_failed');
    return null;
  }
}
