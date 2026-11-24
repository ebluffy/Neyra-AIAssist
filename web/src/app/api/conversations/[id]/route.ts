import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../lib/user-session';
import {
  deleteConversation,
  getConversation,
  listMessages,
  updateConversation,
} from '../../../../../lib/chat-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  try {
    const conversation = await getConversation(user.id, id);
    if (!conversation) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get('message_limit') || '', 10);
    const offset = Number.parseInt(url.searchParams.get('message_offset') || '', 10);
    const page = await listMessages(user.id, id, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    });
    return NextResponse.json({
      ok: true,
      data: {
        conversation,
        messages: page.items,
        total: page.total,
        has_more: page.has_more,
      },
    });
  } catch {
    return NextResponse.json({ error: 'history_unavailable' }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const raw = body as { title?: unknown; pinned?: unknown; folderId?: unknown; archived?: unknown };
  const patch: {
    title?: string;
    pinned?: boolean;
    folderId?: string | null;
    archived?: boolean;
  } = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    patch.title = raw.title;
  }
  if (raw.pinned !== undefined) {
    if (typeof raw.pinned !== 'boolean') {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    patch.pinned = raw.pinned;
  }
  if (raw.folderId !== undefined) {
    if (
      raw.folderId !== null
      && (typeof raw.folderId !== 'string' || !raw.folderId.trim())
    ) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    patch.folderId = raw.folderId;
  }
  if (raw.archived !== undefined) {
    if (typeof raw.archived !== 'boolean') {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    patch.archived = raw.archived;
  }
  try {
    const conversation = await updateConversation(user.id, id, patch);
    if (!conversation) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, data: { conversation } });
  } catch (error) {
    if (error instanceof Error && error.message === 'folder_not_found') {
      return NextResponse.json({ error: 'folder_not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'history_unavailable' }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await context.params;
  try {
    const removed = await deleteConversation(user.id, id);
    if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, data: { archived: true } });
  } catch {
    return NextResponse.json({ error: 'history_unavailable' }, { status: 503 });
  }
}
