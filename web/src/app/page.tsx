import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '../../lib/auth';
import { SignOut } from '../components/sign-out';
import { ru } from '../i18n';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return <main className="mx-auto max-w-sm space-y-6 p-8"><p>{ru.signedIn} {session.user.email}, {ru.role} {session.user.role}</p><SignOut /></main>;
}
