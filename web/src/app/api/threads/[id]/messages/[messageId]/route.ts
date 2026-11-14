import { proxyHistoryRequest } from '../../../../../../../lib/core-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> }
) {
  const { id, messageId } = await context.params;
  return proxyHistoryRequest(
    request,
    `/v1/threads/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'DELETE',
    }
  );
}
