// Чистые правила режима регистрации: без БД и React, чтобы проверялись юнит-тестами.

export const REGISTRATION_MODES = ['invite', 'open', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'invite';

export function isRegistrationMode(value: unknown): value is RegistrationMode {
  return typeof value === 'string' && (REGISTRATION_MODES as readonly string[]).includes(value);
}

// Неизвестное значение в БД не должно открывать регистрацию.
export function parseRegistrationMode(value: unknown): RegistrationMode {
  return isRegistrationMode(value) ? value : DEFAULT_REGISTRATION_MODE;
}

// При недоступной БД: явный INVITE_REQUIRED=false — открытая регистрация,
// всё остальное (и отсутствие env) — безопасный invite.
export function fallbackRegistrationMode(env: Record<string, string | undefined> = process.env): RegistrationMode {
  const raw = (env.INVITE_REQUIRED ?? '').trim().toLowerCase();
  return raw === 'false' ? 'open' : DEFAULT_REGISTRATION_MODE;
}

export interface SignupView {
  showForm: boolean;
  inviteRequired: boolean;
  showInviteNotice: boolean;
  closedMessage: string | null;
}

export const CLOSED_MESSAGE = 'Регистрация закрыта администратором Нейры.';

export function signupView(mode: RegistrationMode): SignupView {
  return {
    showForm: mode !== 'closed',
    inviteRequired: mode === 'invite',
    showInviteNotice: mode === 'invite',
    closedMessage: mode === 'closed' ? CLOSED_MESSAGE : null,
  };
}

// Ссылку «Регистрация» на входе не показываем, когда регистрация закрыта.
export function signupLinkVisible(mode: RegistrationMode): boolean {
  return mode !== 'closed';
}
