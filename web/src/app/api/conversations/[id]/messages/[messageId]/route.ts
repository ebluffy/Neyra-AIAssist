import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../lib/user-session';
import { deleteMessage } from '../../../../../../../lib/chat-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Удаляет ответ и его вопрос: локальный «Удалить обмен» должен пережить reload. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id, messageId } = await context.params;
  try {
    const deleted = await deleteMessage(user.id, id, messageId, { withPreviousUser: true });
    if (!deleted) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'conversation_not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'history_unavailable' }, { status: 503 });
  }
}
