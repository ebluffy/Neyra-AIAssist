import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { getAuth } from '../../../lib/auth';
import { isEnabled } from '../../lib/feature-flags';
import { MemoryView } from './memory-view';

export const dynamic = 'force-dynamic';

export default async function MemoryPage() {
  if (!isEnabled('memory')) {
    notFound();
  }

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) {
    redirect('/login');
  }

  return <MemoryView user={session.user} />;
}
