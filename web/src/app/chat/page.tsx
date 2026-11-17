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
  return (
    <ChatView
      user={session.user}
      needsOnboarding={onboarding.ok ? !onboarding.value : false}
    />
  );
}
