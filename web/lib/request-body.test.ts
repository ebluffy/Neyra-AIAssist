import { describe, expect, it } from 'vitest';
import { readBodyWithLimit } from './request-body';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe('readBodyWithLimit', () => {
  it('returns the exact bytes under the limit', async () => {
    const result = await readBodyWithLimit(streamOf(['abc', 'def']), 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextDecoder().decode(result.bytes)).toBe('abcdef');
  });

  it('counts streamed bytes and stops as soon as the limit is exceeded', async () => {
    const result = await readBodyWithLimit(streamOf(['1234', '5678', '9']), 8);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects an empty body', async () => {
    expect(await readBodyWithLimit(streamOf([]), 10)).toEqual({ ok: false, reason: 'empty' });
    expect(await readBodyWithLimit(null, 10)).toEqual({ ok: false, reason: 'empty' });
  });
});
