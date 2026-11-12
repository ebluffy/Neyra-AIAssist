'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@neyra/ui';
import { signOut } from '../../lib/auth-client';
import { ru } from '../i18n';
export function SignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function exit() {
    setPending(true); setError('');
    try {
      const result = await signOut();
      if (result.error) { setError(ru.networkError); return; }
      router.replace('/login'); router.refresh();
    } catch { setError(ru.networkError); }
    finally { setPending(false); }
  }
  return <><Button onClick={exit} disabled={pending}>{ru.signOut}</Button>{error && <p role="alert">{error}</p>}</>;
}
