'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { LegacyNotice } from '../../components/ui/LegacyNotice';

export default function LegacyPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex flex-col justify-center p-4 sm:p-6">
      <div className="max-w-xl mx-auto w-full mb-4">
        <Link
          href="/chat"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors"
        >
          <ArrowLeft size={14} />
          <span>Вернуться в чат Neyra</span>
        </Link>
      </div>

      <LegacyNotice />
    </div>
  );
}
