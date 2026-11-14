import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../../../lib/auth';
import { ChatView } from './chat-view';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return <ChatView user={session.user} />;
}
