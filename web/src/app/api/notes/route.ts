import { proxyHistoryRequest } from '../../../../lib/core-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const thread_id = searchParams.get('thread_id') || undefined;
  const limit = searchParams.get('limit') || undefined;
  const cursor = searchParams.get('cursor') || undefined;
  return proxyHistoryRequest(request, '/v1/notes', {
    method: 'GET',
    query: { thread_id, limit, cursor },
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  return proxyHistoryRequest(request, '/v1/notes', {
    method: 'POST',
    body,
  });
}
