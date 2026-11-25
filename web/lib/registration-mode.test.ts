import { describe, expect, it } from 'vitest';
import {
  CLOSED_MESSAGE,
  DEFAULT_REGISTRATION_MODE,
  fallbackRegistrationMode,
  isRegistrationMode,
  parseRegistrationMode,
  signupLinkVisible,
  signupView,
} from './registration-mode';

describe('registration mode values', () => {
  it('accepts only the three modes', () => {
    expect(isRegistrationMode('invite')).toBe(true);
    expect(isRegistrationMode('open')).toBe(true);
    expect(isRegistrationMode('closed')).toBe(true);
    expect(isRegistrationMode('OPEN')).toBe(false);
    expect(isRegistrationMode('')).toBe(false);
    expect(isRegistrationMode(undefined)).toBe(false);
  });

  it('never opens registration for an unknown stored value', () => {
    expect(parseRegistrationMode('open')).toBe('open');
    expect(parseRegistrationMode('bogus')).toBe(DEFAULT_REGISTRATION_MODE);
    expect(parseRegistrationMode(null)).toBe('invite');
    expect(parseRegistrationMode(undefined)).toBe('invite');
  });
});

describe('fallback when the database is unavailable', () => {
  it('uses INVITE_REQUIRED=false as open and everything else as invite', () => {
    expect(fallbackRegistrationMode({ INVITE_REQUIRED: 'false' })).toBe('open');
    expect(fallbackRegistrationMode({ INVITE_REQUIRED: 'FALSE' })).toBe('open');
    expect(fallbackRegistrationMode({ INVITE_REQUIRED: 'true' })).toBe('invite');
    expect(fallbackRegistrationMode({})).toBe('invite');
    expect(fallbackRegistrationMode()).toBe('invite');
  });
});

describe('signup view', () => {
  it('keeps the form with a required invite in invite mode', () => {
    expect(signupView('invite')).toEqual({
      showForm: true,
      inviteRequired: true,
      showInviteNotice: true,
      closedMessage: null,
    });
  });

  it('hides the invite requirement in open mode', () => {
    expect(signupView('open')).toEqual({
      showForm: true,
      inviteRequired: false,
      showInviteNotice: false,
      closedMessage: null,
    });
  });

  it('replaces the form with an explanation in closed mode', () => {
    expect(signupView('closed')).toEqual({
      showForm: false,
      inviteRequired: false,
      showInviteNotice: false,
      closedMessage: CLOSED_MESSAGE,
    });
  });
});

describe('login link', () => {
  it('is hidden only when registration is closed', () => {
    expect(signupLinkVisible('invite')).toBe(true);
    expect(signupLinkVisible('open')).toBe(true);
    expect(signupLinkVisible('closed')).toBe(false);
  });
});
