// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { FLAGS, isEnabled, setFlagOverride } from './feature-flags';

describe('Feature Flags Registry', () => {
  beforeEach(() => {
    window.localStorage?.clear();
    // Reset window.location.search
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: { search: string } }).location = { search: '' };
  });

  it('provides expected defaults according to spec §3.3', () => {
    expect(FLAGS.authDiscord).toBe(true);
    expect(FLAGS.authInvite).toBe(false);
    expect(FLAGS.chatAttachments).toBe(false);
    expect(FLAGS.chatVoice).toBe(false);
    expect(FLAGS.mcpAdmin).toBe(false);
    expect(FLAGS.providersCatalog).toBe(false);
    expect(FLAGS.threadsDb).toBe(false);
    expect(FLAGS.notes).toBe(false);
    expect(FLAGS.exportData).toBe(false);

    expect(isEnabled('authDiscord')).toBe(true);
    expect(isEnabled('chatVoice')).toBe(false);
  });

  it('respects localStorage overrides', () => {
    expect(isEnabled('chatVoice')).toBe(false);

    setFlagOverride('chatVoice', true);
    expect(isEnabled('chatVoice')).toBe(true);

    setFlagOverride('authDiscord', false);
    expect(isEnabled('authDiscord')).toBe(false);

    setFlagOverride('authDiscord', null);
    expect(isEnabled('authDiscord')).toBe(true);
  });

  it('respects URL search params overrides with ?ff=...', () => {
    (window as unknown as { location: { search: string } }).location = {
      search: '?ff=chatVoice,chatAttachments,!authDiscord',
    };

    expect(isEnabled('chatVoice')).toBe(true);
    expect(isEnabled('chatAttachments')).toBe(true);
    expect(isEnabled('authDiscord')).toBe(false);
    expect(isEnabled('mcpAdmin')).toBe(false);
  });

  it('respects direct ?ff_<flag>=1 parameter', () => {
    (window as unknown as { location: { search: string } }).location = {
      search: '?ff_mcpAdmin=1&ff_authDiscord=0',
    };

    expect(isEnabled('mcpAdmin')).toBe(true);
    expect(isEnabled('authDiscord')).toBe(false);
  });
});
