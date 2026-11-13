import Link from 'next/link';
import { AuthForm } from '../../components/auth-form';
import { readAuthConfig, type AuthConfig } from '../../../lib/env';
import { getRegistrationMode } from '../../../lib/site-settings';
import { signupView } from '../../../lib/registration-mode';

export const dynamic = 'force-dynamic';

export default async function Signup({ searchParams }: { searchParams?: Promise<{ invite?: string }> }) {
  const params = searchParams ? await searchParams : undefined;
  const config = readAuthConfig();
  // Режим регистрации живёт в БД (site_setting) и читается на сервере.
  const mode = await getRegistrationMode();
  const view = signupView(mode);

  if (!view.showForm) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-xl font-semibold">Регистрация закрыта</h1>
        <p className="text-sm text-[var(--text-muted)]">{view.closedMessage}</p>
        <Link
          href="/login"
          className="mt-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5"
        >
          Ко входу
        </Link>
      </main>
    );
  }

  const effectiveConfig: AuthConfig = {
    authMode: config.authMode,
    inviteRequired: view.inviteRequired,
    discordAvailable: config.discordAvailable,
  };
  return (
    <AuthForm
      mode="signup"
      config={effectiveConfig}
      registrationMode={mode}
      invite={typeof params?.invite === 'string' ? params.invite : ''}
    />
  );
}
