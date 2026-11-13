import { AuthForm } from '../../components/auth-form';
import { readAuthConfig, type AuthConfig } from '../../../lib/env';

export const dynamic = 'force-dynamic';

export default async function Signup({
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
  return <AuthForm mode="signup" config={effectiveConfig} />;
}
