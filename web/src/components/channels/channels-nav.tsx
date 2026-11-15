'use client';
import React from 'react';
import { useRouter } from 'next/navigation';
import { Hash } from 'lucide-react';
import { Button, IconButton } from '../ui';
export function ChannelsNav({ role, compact = false }: { role?: string | null; compact?: boolean }) {
  const router = useRouter();
  if (role !== 'admin') return null;
  return compact
    ? <IconButton aria-label="Каналы" tooltip="Каналы" icon={<Hash size={17} />} onClick={() => router.push('/channels')} />
    : <Button variant="ghost" className="w-full justify-start" onClick={() => router.push('/channels')}><Hash size={16} />Каналы</Button>;
}
