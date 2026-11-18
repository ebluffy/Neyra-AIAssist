import * as undici from 'undici';

export interface PinnedProbeResult {
  status: number;
  ok: boolean;
  json: unknown;
}

// AR-82, AR-89: пиннинг-запрос вынесен в отдельный модуль.
// Чтение тела ответа выполняется ДО закрытия диспетчера, чтобы избежать зависания
// backpressure и TimeoutError при больших ответах (каталоги > 64 КБ, например OpenRouter > 1 МБ).
export async function executePinnedProbe(
  targetEndpoint: string,
  headers: Record<string, string>,
  pinnedList: { address: string; family: number }[],
  timeoutMs = 8000,
): Promise<PinnedProbeResult> {
  const dispatcher = new undici.Agent({
    connect: {
      lookup: (_hostname, opts, cb) => {
        let callback = cb;
        let options = opts;
        if (typeof options === 'function') {
          callback = options;
          options = {};
        }
        if (options && options.all) {
          callback(null, pinnedList as never);
        } else if (pinnedList.length > 0) {
          callback(null, pinnedList[0].address as never, pinnedList[0].family as never);
        } else {
          callback(new Error('NO_PINNED_ADDRESS') as never, '' as never);
        }
      },
    },
  });

  try {
    const res = await undici.fetch(targetEndpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'manual',
      dispatcher,
    });

    let json: unknown = null;
    if (res.status === 200) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }

    return {
      status: res.status,
      ok: res.ok,
      json,
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
