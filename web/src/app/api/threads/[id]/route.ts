import { proxyHistoryRequest } from '../../../../../lib/core-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get('limit') || undefined;
  const before = searchParams.get('before') || undefined;
  return proxyHistoryRequest(request, `/v1/threads/${encodeURIComponent(id)}`, {
    method: 'GET',
    query: { limit, before },
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  return proxyHistoryRequest(request, `/v1/threads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return proxyHistoryRequest(request, `/v1/threads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
