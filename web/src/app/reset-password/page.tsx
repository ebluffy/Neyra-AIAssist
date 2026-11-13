import { ResetPasswordForm } from '../../components/reset-password-form';

export const dynamic = 'force-dynamic';

// Страница, куда ядро входа перенаправляет по ссылке сброса (?token=…).
export default async function ResetPasswordPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  return <ResetPasswordForm token={token} />;
}
