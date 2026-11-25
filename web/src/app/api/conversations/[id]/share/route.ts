import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../lib/user-session';
import {
  createConversationShare,
  getActiveShare,
  revokeConversationShares,
  SHARE_TTLS,
  type ShareTtl,
} from '../../../../../../lib/share-store';
import { getConversation } from '../../../../../../lib/chat-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  try {
    const room = await getConversation(user.id, id);
    if (!room) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const active = await getActiveShare(user.id, id);
    return NextResponse.json({
      ok: true,
      data: {
        active: Boolean(active),
        expires_at: active?.expiresAt?.toISOString() ?? null,
      },
    });
  } catch {
    return NextResponse.json({ error: 'share_unavailable' }, { status: 503 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  let ttl: ShareTtl = '7d';
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && 'ttl' in body) {
      if (!SHARE_TTLS.includes(body.ttl as ShareTtl)) {
        return NextResponse.json({ error: 'bad_request' }, { status: 400 });
      }
      ttl = body.ttl as ShareTtl;
    }
  } catch {
    // пустое тело — срок по умолчанию
  }
  try {
    const created = await createConversationShare(user.id, id, ttl);
    if (!created) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({
      ok: true,
      data: {
        url: `/share/${created.token}`,
        expires_at: created.expiresAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'conversation_archived') {
      return NextResponse.json({ error: 'conversation_archived' }, { status: 409 });
    }
    return NextResponse.json({ error: 'share_unavailable' }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  try {
    const revoked = await revokeConversationShares(user.id, id);
    return NextResponse.json({ ok: true, data: { revoked } });
  } catch {
    return NextResponse.json({ error: 'share_unavailable' }, { status: 503 });
  }
}
