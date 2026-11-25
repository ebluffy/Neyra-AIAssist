import { NextResponse } from 'next/server';
import { getSessionUser } from '../../../../lib/user-session';
import { ensureConversation, listConversations } from '../../../../lib/chat-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const offset = Number.parseInt(url.searchParams.get('offset') || '', 10);
    const page = await listConversations(user.id, {
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    });
    return NextResponse.json({ ok: true, data: page });
  } catch {
    return NextResponse.json({ error: 'history_unavailable' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const raw = body as { id?: unknown; title?: unknown; model?: unknown };
  let id = crypto.randomUUID();
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    id = raw.id;
  }
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : 'Новый диалог';
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : '';
  try {
    const conversation = await ensureConversation(user.id, id, title, model);
    return NextResponse.json({ ok: true, data: { conversation } }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'conversation_forbidden') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    return NextResponse.json({ error: 'history_unavailable' }, { status: 503 });
  }
}
