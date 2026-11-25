import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../../../lib/auth';
import { getUserOnboardingCompleted } from '../../../lib/admin-users';
import { listConversations } from '../../../lib/chat-store';
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
  let initialThreads: { id: string; title: string; updatedAt: string }[] = [];
  try {
    const page = await listConversations(session.user.id, { limit: 100 });
    initialThreads = page.items.map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt.toISOString(),
    }));
  } catch {
    initialThreads = [];
  }
  return (
    <ChatView
      user={{ ...session.user, discord_id: discordId }}
      initialThreads={initialThreads}
    />
  );
}
