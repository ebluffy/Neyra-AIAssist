'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../ui';

export interface ExportPerson {
  id: string;
  displayName: string;
  names: string[];
  accounts: string[];
  discordIds: string[];
}

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
      <Button
        variant="secondary"
        size="sm"
        disabled={people.length === 0}
        onClick={download}
      >
        <Download size={14} className="mr-1.5" />
        <span>Экспорт списка (JSON)</span>
      </Button>
      {error && <span role="alert" className="text-xs text-[var(--danger)]">{error}</span>}
    </div>
  );
}
