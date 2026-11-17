import * as undici from 'undici';

// AR-82: пиннинг-запрос вынесен в отдельный модуль, использующий undici.fetch и undici.Agent
// из одного пакета с автоматическим закрытием диспетчера в finally.
export async function executePinnedProbe(
  targetEndpoint: string,
  headers: Record<string, string>,
  pinnedList: { address: string; family: number }[],
  timeoutMs = 8000,
) {
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
    return await undici.fetch(targetEndpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'manual',
      dispatcher,
    });
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
