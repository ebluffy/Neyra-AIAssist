'use client';

import { useState } from 'react';

export interface ExportPerson {
  id: string;
  displayName: string;
  names: string[];
  accounts: string[];
  discordIds: string[];
}

// Экспорт ровно того, что показано: ядро не отдаёт полного экспорта памяти,
// поэтому выгружаем список людей из текущей выборки, без домыслов.
export function ExportPeople({ people }: { people: ExportPerson[] }) {
  const [error, setError] = useState('');

  function download() {
    try {
      const body = JSON.stringify({ exportedAt: new Date().toISOString(), people }, null, 2);
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `neyra-people-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setError('');
    } catch {
      setError('Не удалось выгрузить файл в этом браузере.');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={download}
        disabled={people.length === 0}
        className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-40"
      >
        Экспорт списка (JSON)
      </button>
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
    </div>
  );
}
