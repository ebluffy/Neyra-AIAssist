import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../../../lib/auth';
import { SettingsView } from './settings-view';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return <SettingsView user={session.user} />;
}
