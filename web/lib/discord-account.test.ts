import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getAuth } from './auth';
import { getLinkedDiscordId } from './discord-account';

vi.mock('./auth', () => ({ getAuth: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getLinkedDiscordId', () => {
  it('returns the linked Discord account id', async () => {
    vi.mocked(getAuth).mockReturnValue({
      api: { listUserAccounts: vi.fn().mockResolvedValue([{ providerId: 'discord', accountId: 'discord-user-1' }]) },
    } as unknown as ReturnType<typeof getAuth>);
    await expect(getLinkedDiscordId(new Headers())).resolves.toBe('discord-user-1');
  });

  it('returns null when Discord is not linked', async () => {
    vi.mocked(getAuth).mockReturnValue({
      api: { listUserAccounts: vi.fn().mockResolvedValue([]) },
    } as unknown as ReturnType<typeof getAuth>);
    await expect(getLinkedDiscordId(new Headers())).resolves.toBeNull();
  });

  it('logs only a fixed code and returns null on lookup failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getAuth).mockReturnValue({
      api: { listUserAccounts: vi.fn().mockRejectedValue(new Error('db down secret')) },
    } as unknown as ReturnType<typeof getAuth>);
    await expect(getLinkedDiscordId(new Headers())).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('discord_account_lookup_failed');
    warn.mockRestore();
  });
});
