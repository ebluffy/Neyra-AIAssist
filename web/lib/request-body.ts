// Чтение тела запроса с жёстким лимитом: считаем байты по мере прихода и
// прекращаем чтение, как только превысили потолок. Content-Length проверяется
// отдельно до вызова, но ему нельзя верить: фактический размер считаем сами.

export type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'empty' | 'too_large' };

export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<BodyReadResult> {
  if (!body) return { ok: false, reason: 'empty' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* уже закрыт */ }
  }
  if (total === 0) return { ok: false, reason: 'empty' };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
