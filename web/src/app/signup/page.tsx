import { AuthForm } from '../../components/auth-form';
import { readAuthConfig, type AuthConfig } from '../../../lib/env';

export const dynamic = 'force-dynamic';

export default async function Signup({ searchParams }: { searchParams?: Promise<{ invite?: string }> }) {
  const params = searchParams ? await searchParams : undefined;
  const config = readAuthConfig();
  const effectiveConfig: AuthConfig = {
    authMode: config.authMode,
    inviteRequired: config.inviteRequired,
    discordAvailable: config.discordAvailable,
  };
  return <AuthForm mode="signup" config={effectiveConfig} invite={typeof params?.invite === 'string' ? params.invite : ''} />;
}
