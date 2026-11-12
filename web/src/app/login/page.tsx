import { Button, Field } from '@neyra/ui';
import { ru } from '../../i18n';
export default function Login() { return <main className="mx-auto max-w-sm space-y-6 p-8"><h1>{ru.login}</h1><form aria-label={ru.login} className="space-y-4"><Field label={ru.username} autoComplete="username" disabled /><Field label={ru.password} type="password" autoComplete="current-password" disabled /><Button disabled>{ru.submit}</Button><p>{ru.pending}</p></form></main>; }
