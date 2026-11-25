import React from 'react';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuth } from '../../../../lib/auth';
import { resolveShareToken } from '../../../../lib/share-store';
import { MarkdownMessage } from '../../../components/ui/MarkdownMessage';

export const dynamic = 'force-dynamic';

export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/share/${token}`)}`);
  }
  let shared = null;
  try {
    shared = await resolveShareToken(token);
  } catch {
    shared = null;
  }
  if (!shared) notFound();

  return (
    <main className="min-h-[100svh] bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <Link href="/chat" className="text-sm font-semibold tracking-tight">
            Neyra
          </Link>
          <span className="text-[11px] text-[var(--text-subtle)]">
            Просмотр по ссылке · только для вошедших
          </span>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
        <div className="mb-6 border-b border-[var(--border)] pb-4">
          <h1 className="text-lg font-semibold tracking-tight break-words">
            {shared.conversation.title}
          </h1>
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
            Диалог с Нейрой · {shared.total} сообщений
          </p>
        </div>
        {shared.has_more && (
          <div className="mb-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-[11px] text-[var(--text-muted)]">
            Показаны последние {shared.messages.length} из {shared.total} сообщений.
          </div>
        )}
        <div className="space-y-5">
          {shared.messages.map((message) =>
            message.role === 'user' ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] px-3.5 py-2.5 text-[15px] leading-[24px] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {message.content}
                </div>
              </div>
            ) : (
              <div key={message.id} className="w-full">
                {message.status === 'error' ? (
                  <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3.5 text-xs text-[var(--danger)]">
                    {message.content}
                  </div>
                ) : (
                  <MarkdownMessage content={message.content} />
                )}
              </div>
            ),
          )}
        </div>
        <p className="mt-8 border-t border-[var(--border)] pt-4 text-[11px] text-[var(--text-subtle)]">
          Ссылку можно отозвать в панели диалога. Если доступ больше не нужен, попросите автора
          отозвать её.
        </p>
      </article>
    </main>
  );
}
