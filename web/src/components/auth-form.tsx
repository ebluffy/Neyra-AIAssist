'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field } from '@neyra/ui';
import { signIn, signUp } from '../../lib/auth-client';
import { credentialsSchema, authErrorText } from '../../lib/auth-policy';
import { ru } from '../i18n';
export function AuthForm({ mode, invite = '' }: { mode: 'login' | 'signup'; invite?: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [inviteCode, setInviteCode] = useState(invite);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const parsed = credentialsSchema.safeParse({ email: form.get('email'), password: form.get('password') });
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    const token = inviteCode.trim();
    if (mode === 'signup' && !token) { setError(ru.inviteRequired); return; }
    setError(''); setPending(true);
    try {
      const result = mode === 'signup'
        ? await signUp.email({ ...parsed.data, name: parsed.data.email, invite: token } as Parameters<typeof signUp.email>[0])
        : await signIn.email(parsed.data);
      if (result.error) { setError(authErrorText(result.error.code, result.error.message)); return; }
      router.replace('/'); router.refresh();
    } catch { setError(ru.networkError); }
    finally { setPending(false); }
  }
  return <main className="mx-auto max-w-sm space-y-6 p-8"><h1>{mode === 'login' ? ru.login : ru.signup}</h1>
    {mode === 'signup' && (invite
      ? <p>{ru.inviteApplied}</p>
      : <p>{ru.inviteOnly}</p>)}
    <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
      <Field label={ru.email} name="email" type="email" autoComplete="email" required disabled={pending} />
      <Field label={ru.password} name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={10} maxLength={128} required disabled={pending} />
      {mode === 'signup' && !invite &&
        <Field label={ru.inviteCode} name="invite" type="text" autoComplete="off" required disabled={pending}
          value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} />}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={pending}>{pending ? ru.wait : mode === 'login' ? ru.submit : ru.register}</Button>
    </form>
    <Link href={mode === 'login' ? '/signup' : '/login'}>{mode === 'login' ? ru.signup : ru.login}</Link>
  </main>;
}
