import { proxyHistoryRequest } from '../../../../../lib/core-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  return proxyHistoryRequest(request, `/v1/notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return proxyHistoryRequest(request, `/v1/notes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
