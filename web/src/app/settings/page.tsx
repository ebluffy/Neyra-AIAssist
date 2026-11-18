import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  redirect('/chat?settings=1');
}
