'use client';

import { useCallback, useEffect, useState } from 'react';

interface Tail {
  file: string;
  lines: string[];
  count: number;
  truncated: boolean;
  missing: boolean;
  supported?: boolean;
  message?: string;
}

const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-40';

export function LogTail({ lines = 200 }: { lines?: number }) {
  const [data, setData] = useState<Tail | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');

  const load = useCallback(async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/logs/tail?lines=${lines}`);
      const payload = await response.json().catch(() => null) as { ok?: boolean; data?: Tail; message?: string } | null;
      if (!response.ok || payload?.ok === false || !payload?.data) {
        throw new Error(payload?.message ?? 'Ядро не отдало лог.');
      }
      if (payload.data.supported === false) {
        setData(null);
        setError(payload.data.message ?? 'Ядро не поддерживает просмотр логов.');
        return;
      }
      setData(payload.data);
      setUpdatedAt(new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось получить лог.');
    } finally {
      setPending(false);
    }
  }, [lines]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
        <button type="button" className={buttonClass} disabled={pending} onClick={() => void load()}>
          {pending ? 'Обновляю…' : 'Обновить'}
        </button>
        {data && <span>{data.file} · строк: {data.count}{data.truncated ? ' · показан хвост' : ''}</span>}
        {updatedAt && <span>обновлено в {updatedAt} МСК</span>}
        {error && <span role="alert" className="text-[var(--danger)]">{error}</span>}
      </div>
      {data?.missing ? (
        <p className="text-xs text-[var(--muted)]">Файл лога ещё не создан: ядро не писало в него после старта.</p>
      ) : (
        <pre className="max-h-[420px] overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-black/30 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
          {data ? data.lines.join('\n') : 'Загружаю…'}
        </pre>
      )}
      <p className="text-xs text-[var(--muted)]">Секреты маскируются ядром до отправки; путь к файлу наружу не отдаётся.</p>
    </div>
  );
}
