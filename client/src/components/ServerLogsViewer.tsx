import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatError, unwrapApi, type LogSource, type LogTailData, type Plugin } from '../types';

export const LOG_SOURCES: LogSource[] = [
  { id: 'system', label: 'system (системный лог ядра)' },
  { id: 'audit', label: 'audit (журнал аудита API, maint+)', maintOnly: true },
  { id: 'chat', label: 'chat (диалоги чата, maint+)', maintOnly: true },
  { id: 'health', label: 'health (проверки доступности)' },
  { id: 'lavalink', label: 'lavalink (аудио-подсистема)' },
];

export const TAIL_OPTIONS = [50, 100, 200, 500, 1000] as const;

export function ServerLogsViewer({ profileId, plugins }: { profileId: string; plugins?: Plugin[] }) {
  const [source, setSource] = useState('system');
  const [tail, setTail] = useState<number>(200);
  const [logData, setLogData] = useState<LogTailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const bumpRequestId = useCallback(() => {
    requestIdRef.current += 1;
  }, []);

  const fetchLogs = useCallback((activeSource: string, activeTail: number) => {
    const reqId = ++requestIdRef.current;
    if (!profileId) {
      setLogData(null);
      setError('Выберите сервер и проверьте подключение.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const path = `/v1/logs?source=${encodeURIComponent(activeSource)}&tail=${activeTail}`;
    invoke<unknown>('api', { profileId, path, method: 'GET' })
      .then(res => {
        if (reqId === requestIdRef.current) {
          setLogData(unwrapApi<LogTailData>(res));
          setError(null);
        }
      })
      .catch(e => {
        if (reqId === requestIdRef.current) {
          setLogData(null);
          setError(formatError(e));
        }
      })
      .finally(() => {
        if (reqId === requestIdRef.current) {
          setLoading(false);
        }
      });
  }, [profileId]);

  useEffect(() => {
    const reqId = ++requestIdRef.current;
    if (!profileId) {
      void Promise.resolve().then(() => {
        if (reqId === requestIdRef.current) {
          setLogData(null);
          setError(null);
          setLoading(false);
        }
      });
      return () => {
        bumpRequestId();
      };
    }

    void Promise.resolve().then(() => {
      if (reqId === requestIdRef.current) {
        setLogData(null);
        setError(null);
        setLoading(true);
      }
    });

    const path = `/v1/logs?source=${encodeURIComponent(source)}&tail=${tail}`;
    invoke<unknown>('api', { profileId, path, method: 'GET' })
      .then(res => {
        if (reqId === requestIdRef.current) {
          setLogData(unwrapApi<LogTailData>(res));
          setError(null);
        }
      })
      .catch(e => {
        if (reqId === requestIdRef.current) {
          setLogData(null);
          setError(formatError(e));
        }
      })
      .finally(() => {
        if (reqId === requestIdRef.current) {
          setLoading(false);
        }
      });

    return () => {
      bumpRequestId();
    };
  }, [profileId, source, tail, bumpRequestId]);

  const allSources: LogSource[] = [
    ...LOG_SOURCES,
    ...(plugins ?? []).map(p => ({
      id: `plugin:${p.id}`,
      label: `plugin:${p.id} (${p.name ?? p.id})`,
    })),
  ];
  const selectedSource = allSources.find(s => s.id === source);

  return (
    <div className="group server-logs-viewer" aria-label="Просмотр серверных логов">
      <h2>Серверные логи</h2>
      {!profileId && (
        <p className="hint" role="status">
          Выберите сервер в настройках для загрузки логов.
        </p>
      )}
      <div className="row">
        <label>
          Источник логов
          <select
            name="log-source"
            autoComplete="off"
            value={source}
            disabled={!profileId || loading}
            onChange={e => setSource(e.target.value)}
          >
            {allSources.map(s => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {selectedSource?.maintOnly && (
            <span className="hint" role="note">
              Требуются права maint+.
            </span>
          )}
        </label>
        <label>
          Строк (хвост)
          <select
            name="log-tail"
            autoComplete="off"
            value={tail}
            disabled={!profileId || loading}
            onChange={e => setTail(Number(e.target.value))}
          >
            {TAIL_OPTIONS.map(num => (
              <option key={num} value={num}>
                {num} строк
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          disabled={!profileId || loading}
          onClick={() => void fetchLogs(source, tail)}
        >
          {loading ? 'Загружаю…' : 'Обновить логи'}
        </button>
      </div>

      {loading && (
        <p className="hint" role="status">
          Загрузка логов…
        </p>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {profileId && !loading && !error && logData && (
        <div className="log-output">
          <p className="path">
            Файл: {logData.path || logData.source} {!logData.exists && '(файл ещё не создан на сервере)'}
          </p>
          {source.startsWith('plugin:') &&
            (logData.path.endsWith('system.log') || logData.source !== source) && (
              <p className="hint" role="status">
                Собственный лог модуля отсутствует на сервере; показан системный лог.
              </p>
            )}
          {logData.text.trim().length === 0 ? (
            <p className="hint" role="status">
              Лог пуст.
            </p>
          ) : (
            <pre tabIndex={0} aria-label={`Текст лога ${logData.source}`}>
              {logData.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
