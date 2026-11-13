import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getAdminUser } from '../../../lib/admin-page-guard';
import { AdminNav } from '../../components/admin/admin-nav';

export const dynamic = 'force-dynamic';

// Вход только для role=admin. Остальным — 404, чтобы не подтверждать существование раздела.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getAdminUser();
  if (!user) notFound();
  return (
    <div className="min-h-screen">
      <AdminNav email={user.email} />
      <main className="mx-auto max-w-[1200px] px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
