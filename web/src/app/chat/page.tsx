import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../../../lib/auth';
import { getUserOnboardingCompleted } from '../../../lib/admin-users';
import { ChatView } from './chat-view';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const onboarding = await getUserOnboardingCompleted(session.user.id);
  if (onboarding.ok && !onboarding.value) redirect('/onboarding');
  let discordId: string | null = null;
  try {
    const accounts = await getAuth().api.listUserAccounts({ headers: await headers() });
    discordId = accounts.find((account) => account.providerId === 'discord')?.accountId ?? null;
  } catch {
    discordId = null;
  }
  return <ChatView user={{ ...session.user, discord_id: discordId }} />;
}
