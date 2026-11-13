import { AuthForm } from '../../components/auth-form';
import { readAuthConfig, type AuthConfig } from '../../../lib/env';
import { getRegistrationMode } from '../../../lib/site-settings';

export const dynamic = 'force-dynamic';

export default async function Login({
  searchParams,
}: {
  searchParams?: Promise<{ mode?: string; invite?: string; error?: string }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const config = readAuthConfig();
  const effectiveConfig: AuthConfig = {
    authMode: (params?.mode as any) || config.authMode,
    inviteRequired: params?.invite === 'true' || config.inviteRequired,
    discordAvailable: params?.mode === 'discord' || params?.mode === 'both' ? true : config.discordAvailable,
  };
  // Ссылку «Регистрация» прячем, когда регистрация закрыта админом.
  const registrationMode = await getRegistrationMode();
  return <AuthForm mode="login" config={effectiveConfig} registrationMode={registrationMode} />;
}
