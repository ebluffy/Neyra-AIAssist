import React from "react";
import { notFound } from 'next/navigation';
import { getAdminUser } from '../../../lib/admin-page-guard';
import { ChannelsView } from '../../components/channels/channels-view';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  const user = await getAdminUser();
  if (!user) notFound();
  return <ChannelsView userId={user.id} user={user} />;
}
