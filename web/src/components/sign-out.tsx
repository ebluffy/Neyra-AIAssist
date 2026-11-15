'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { IconButton } from './ui';
import { signOut } from '../../lib/auth-client';
import { ru } from '../i18n';

export function SignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function exit() {
    setPending(true);
    setError('');
    try {
      const result = await signOut();
      if (result.error) {
        setError(ru.networkError);
        return;
      }
      router.replace('/login');
      router.refresh();
    } catch {
      setError(ru.networkError);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <IconButton
        type="button"
        aria-label={ru.signOut}
        tooltip={ru.signOut}
        icon={<LogOut size={15} strokeWidth={1.5} />}
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={exit}
        className="rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)]"
      />
      {error && <span role="alert" className="text-xs text-[var(--danger)]">{error}</span>}
    </>
  );
}
