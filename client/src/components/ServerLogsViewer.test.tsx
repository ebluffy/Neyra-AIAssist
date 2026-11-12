import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerLogsViewer, LOG_SOURCES, TAIL_OPTIONS } from './ServerLogsViewer';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));

describe('ServerLogsViewer component and production flow', () => {
  let root: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    ipc.invoke.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders standard log sources, maint+ indicator, and tail limits', async () => {
    expect(LOG_SOURCES.map(s => s.id)).toEqual(['system', 'audit', 'chat', 'health', 'lavalink']);
    expect(TAIL_OPTIONS).toEqual([50, 100, 200, 500, 1000]);

    ipc.invoke.mockResolvedValue({
      ok: true,
      trace_id: 'tr-1',
      data: { source: 'system', path: 'data/logs/system.log', exists: true, text: 'ok' },
    });

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    // Default source 'system' does not have maintOnly
    expect(root!.root.findAllByProps({ role: 'note' }).length).toBe(0);

    // Switch source to 'audit' which has maintOnly: true
    const select = root!.root.findByProps({ name: 'log-source' });
    await act(async () => {
      select.props.onChange({ target: { value: 'audit' } });
    });

    const note = root!.root.findByProps({ role: 'note' });
    expect(note.children.join('')).toContain('Требуются права maint+');
  });

  it('shows hint when profileId is empty and does not query backend', async () => {
    await act(async () => {
      root = create(<ServerLogsViewer profileId="" />);
    });
    expect(ipc.invoke).not.toHaveBeenCalled();
    const hint = root!.root.findByProps({ role: 'status' });
    expect(hint.children.join('')).toContain('Выберите сервер в настройках');
  });

  it('resets logData and error when profileId becomes empty (P2.1)', async () => {
    ipc.invoke.mockResolvedValueOnce({
      ok: true,
      trace_id: 'tr-1',
      data: {
        source: 'system',
        path: 'data/logs/system.log',
        exists: true,
        text: 'active logs from prof-1',
      },
    });

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });
    expect(root!.root.findAllByType('pre').length).toBe(1);

    // Switch profileId to empty
    await act(async () => {
      root!.update(<ServerLogsViewer profileId="" />);
    });

    // Stale logs and output container must be gone immediately
    expect(root!.root.findAllByType('pre').length).toBe(0);
    expect(root!.root.findAllByProps({ className: 'log-output' }).length).toBe(0);
    const hint = root!.root.findByProps({ role: 'status' });
    expect(hint.children.join('')).toContain('Выберите сервер в настройках');
  });

  it('auto-fetch sets loading state and clears previous error (P2.2)', async () => {
    ipc.invoke.mockRejectedValueOnce('Сервер вернул HTTP 500');

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    const errorAlert = root!.root.findByProps({ role: 'alert' });
    expect(errorAlert.children.join('')).toContain('HTTP 500');

    let resolveLogs: (val: unknown) => void = () => {};
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveLogs = resolve;
        })
    );

    // Trigger auto-fetch via tail limit change
    const tailSelect = root!.root.findByProps({ name: 'log-tail' });
    await act(async () => {
      tailSelect.props.onChange({ target: { value: '500' } });
    });

    // In flight: loading is active and previous error is cleared
    expect(root!.root.findAllByProps({ role: 'alert' }).length).toBe(0);
    const loadingStatus = root!.root.findByProps({ role: 'status' });
    expect(loadingStatus.children.join('')).toContain('Загрузка логов…');

    // Resolve request
    await act(async () => {
      resolveLogs({
        ok: true,
        trace_id: 'tr-tail',
        data: { source: 'system', path: 'logs/system.log', exists: true, text: 'tail 500 lines' },
      });
    });

    expect(root!.root.findByType('pre').props.children).toBe('tail 500 lines');
  });

  it('handles source-change race condition by discarding stale responses (P3.6)', async () => {
    let slowResolve: (val: unknown) => void = () => {};
    ipc.invoke.mockImplementation((_cmd: string, args: { path: string }) => {
      if (args.path.includes('source=system')) {
        return new Promise(resolve => {
          slowResolve = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        trace_id: 'tr-health',
        data: { source: 'health', path: 'logs/health_status.jsonl', exists: true, text: 'health ok' },
      });
    });

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    // User switches source to health while system request is still pending
    const sourceSelect = root!.root.findByProps({ name: 'log-source' });
    await act(async () => {
      sourceSelect.props.onChange({ target: { value: 'health' } });
    });

    // Health resolved and rendered
    expect(root!.root.findByType('pre').props.children).toBe('health ok');

    // System slow request resolves late
    await act(async () => {
      slowResolve({
        ok: true,
        trace_id: 'tr-stale',
        data: { source: 'system', path: 'logs/system.log', exists: true, text: 'stale system log' },
      });
    });

    // Content must still be health ok
    expect(root!.root.findByType('pre').props.children).toBe('health ok');
  });

  it('encodes plugin log source query parameter correctly (P3.6)', async () => {
    ipc.invoke.mockResolvedValue({
      ok: true,
      trace_id: 'tr-p',
      data: {
        source: 'plugin:telegram',
        path: 'modules/telegram/logs/module.log',
        exists: true,
        text: 'tg bot ready',
      },
    });

    await act(async () => {
      root = create(
        <ServerLogsViewer
          profileId="prof-1"
          plugins={[{ id: 'telegram', name: 'Telegram Bot', enabled: true }]}
        />
      );
    });

    const sourceSelect = root!.root.findByProps({ name: 'log-source' });
    await act(async () => {
      sourceSelect.props.onChange({ target: { value: 'plugin:telegram' } });
    });

    expect(ipc.invoke).toHaveBeenLastCalledWith('api', {
      profileId: 'prof-1',
      path: '/v1/logs?source=plugin%3Atelegram&tail=200',
      method: 'GET',
    });
  });

  it('displays honest fallback notice when plugin log resolves to system.log (P3.5)', async () => {
    ipc.invoke.mockResolvedValue({
      ok: true,
      trace_id: 'tr-fb',
      data: {
        source: 'plugin:weather',
        path: 'data/logs/system.log',
        exists: true,
        text: 'system log fallback text',
      },
    });

    await act(async () => {
      root = create(
        <ServerLogsViewer
          profileId="prof-1"
          plugins={[{ id: 'weather', name: 'Weather Plugin', enabled: true }]}
        />
      );
    });

    const sourceSelect = root!.root.findByProps({ name: 'log-source' });
    await act(async () => {
      sourceSelect.props.onChange({ target: { value: 'plugin:weather' } });
    });

    const statuses = root!.root.findAllByProps({ role: 'status' });
    const fallbackNotice = statuses.find(s =>
      s.children.join('').includes('Собственный лог модуля отсутствует')
    );
    expect(fallbackNotice).toBeDefined();
    expect(root!.root.findByType('pre').props.children).toBe('system log fallback text');
  });

  it('verifies no auto-polling occurs (single invoke per change) (P3.6)', async () => {
    vi.useFakeTimers();
    try {
      ipc.invoke.mockResolvedValue({
        ok: true,
        trace_id: 'tr-poll',
        data: { source: 'system', path: 'logs/system.log', exists: true, text: 'log data' },
      });

      await act(async () => {
        root = create(<ServerLogsViewer profileId="prof-1" />);
      });

      expect(ipc.invoke).toHaveBeenCalledTimes(1);

      // Advance timers by 60 seconds - no automatic polling interval should exist
      await act(async () => {
        vi.advanceTimersByTime(60000);
      });

      expect(ipc.invoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps status-only HTTP 400 to a generic request error', async () => {
    ipc.invoke.mockRejectedValueOnce('Сервер вернул HTTP 400');

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    const alert = root!.root.findByProps({ role: 'alert' });
    expect(alert.children.join('')).toContain('Неверный запрос (HTTP 400).');
  });

  it('fetches logs on mount for active profile and renders output safely', async () => {
    ipc.invoke.mockResolvedValueOnce({
      ok: true,
      trace_id: 'tr-1',
      data: {
        source: 'system',
        path: 'data/logs/system.log',
        exists: true,
        text: 'line 1: server started\nline 2: ready for connections',
      },
    });

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    expect(ipc.invoke).toHaveBeenCalledWith('api', {
      profileId: 'prof-1',
      path: '/v1/logs?source=system&tail=200',
      method: 'GET',
    });

    const pre = root!.root.findByType('pre');
    expect(pre.props.children).toBe('line 1: server started\nline 2: ready for connections');
    expect(pre.props['aria-label']).toBe('Текст лога system');
    const pathText = root!.root.findByProps({ className: 'path' });
    expect(pathText.children.join('')).toContain('data/logs/system.log');
  });

  it('handles empty log text cleanly without crashes', async () => {
    ipc.invoke.mockResolvedValueOnce({
      ok: true,
      trace_id: 'tr-empty',
      data: {
        source: 'system',
        path: 'data/logs/system.log',
        exists: true,
        text: '   \n  ',
      },
    });

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    const statusP = root!.root.findByProps({ role: 'status' });
    expect(statusP.children.join('')).toBe('Лог пуст.');
  });

  it('handles 401 unauthorized with human-readable error', async () => {
    ipc.invoke.mockRejectedValueOnce('Сервер вернул HTTP 401');

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    const alert = root!.root.findByProps({ role: 'alert' });
    expect(alert.children.join('')).toContain('Ошибка авторизации (HTTP 401)');
  });

  it('handles 403 forbidden when inspecting maint-only logs', async () => {
    ipc.invoke.mockRejectedValueOnce('Сервер вернул HTTP 403');

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    const alert = root!.root.findByProps({ role: 'alert' });
    expect(alert.children.join('')).toContain('Доступ запрещён (HTTP 403)');
  });

  it('handles offline / network disconnect gracefully', async () => {
    ipc.invoke.mockRejectedValueOnce('Сервер недоступен; проверьте адрес и сеть');

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    const alert = root!.root.findByProps({ role: 'alert' });
    expect(alert.children.join('')).toBe('Сервер недоступен; проверьте адрес и сеть');
  });

  it('regression: deferred manual-refresh followed by profile clear discards late rejection and resolution', async () => {
    ipc.invoke.mockResolvedValueOnce({
      ok: true,
      trace_id: 'tr-init',
      data: {
        source: 'system',
        path: 'data/logs/system.log',
        exists: true,
        text: 'initial logs from prof-1',
      },
    });

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });
    expect(root!.root.findByType('pre').props.children).toBe('initial logs from prof-1');

    // 1. Manual refresh with deferred rejection
    let rejectManual!: (reason: unknown) => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectManual = reject;
        })
    );

    const refreshButton = root!.root.findByType('button');
    await act(async () => {
      refreshButton.props.onClick();
    });

    expect(refreshButton.props.children).toBe('Загружаю…');

    // User clears profile while manual refresh is pending
    await act(async () => {
      root!.update(<ServerLogsViewer profileId="" />);
    });

    // Verify initial clean state with prompt
    expect(root!.root.findAllByType('pre').length).toBe(0);
    expect(root!.root.findAllByProps({ role: 'alert' }).length).toBe(0);
    expect(root!.root.findByProps({ role: 'status' }).children.join('')).toContain('Выберите сервер в настройках');

    // Late rejection from manual refresh arrives
    await act(async () => {
      rejectManual('Сетевая ошибка 503');
    });

    // Neither error nor logs must appear
    expect(root!.root.findAllByProps({ role: 'alert' }).length).toBe(0);
    expect(root!.root.findAllByType('pre').length).toBe(0);
    expect(root!.root.findByProps({ role: 'status' }).children.join('')).toContain('Выберите сервер в настройках');

    // 2. Late resolution after profile clear
    ipc.invoke.mockResolvedValueOnce({
      ok: true,
      trace_id: 'tr-init-2',
      data: {
        source: 'system',
        path: 'data/logs/system.log',
        exists: true,
        text: 'logs for prof-2',
      },
    });

    await act(async () => {
      root!.update(<ServerLogsViewer profileId="prof-2" />);
    });
    expect(root!.root.findByType('pre').props.children).toBe('logs for prof-2');

    let resolveManual!: (val: unknown) => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveManual = resolve;
        })
    );

    const refreshBtn2 = root!.root.findByType('button');
    await act(async () => {
      refreshBtn2.props.onClick();
    });

    // Clear profile while in flight
    await act(async () => {
      root!.update(<ServerLogsViewer profileId="" />);
    });

    // Late resolve arrives
    await act(async () => {
      resolveManual({
        ok: true,
        trace_id: 'tr-stale-manual',
        data: {
          source: 'system',
          path: 'data/logs/system.log',
          exists: true,
          text: 'stale manual log after clear',
        },
      });
    });

    // Must strictly remain empty
    expect(root!.root.findAllByType('pre').length).toBe(0);
    expect(root!.root.findAllByProps({ role: 'alert' }).length).toBe(0);
    expect(root!.root.findByProps({ role: 'status' }).children.join('')).toContain('Выберите сервер в настройках');
  });

  it('regression: switching from one non-empty profile to another discards stale delayed response', async () => {
    let resolveProf1!: (val: unknown) => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveProf1 = resolve;
        })
    );

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    // prof-1 is still loading
    expect(root!.root.findByProps({ role: 'status' }).children.join('')).toContain('Загрузка логов…');

    // Switch to prof-2 which resolves immediately
    ipc.invoke.mockResolvedValueOnce({
      ok: true,
      trace_id: 'tr-prof2',
      data: {
        source: 'system',
        path: 'data/logs/system.log',
        exists: true,
        text: 'logs from prof-2',
      },
    });

    await act(async () => {
      root!.update(<ServerLogsViewer profileId="prof-2" />);
    });

    // prof-2 rendered
    expect(root!.root.findByType('pre').props.children).toBe('logs from prof-2');

    // prof-1 late resolve arrives
    await act(async () => {
      resolveProf1({
        ok: true,
        trace_id: 'tr-prof1-late',
        data: {
          source: 'system',
          path: 'data/logs/system.log',
          exists: true,
          text: 'stale logs from prof-1',
        },
      });
    });

    // Content must strictly remain from prof-2
    expect(root!.root.findByType('pre').props.children).toBe('logs from prof-2');
  });

  it('regression: unmounting while request is in flight discards late response cleanly', async () => {
    let resolvePending!: (val: unknown) => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolvePending = resolve;
        })
    );

    await act(async () => {
      root = create(<ServerLogsViewer profileId="prof-1" />);
    });

    await act(async () => {
      root!.unmount();
      root = undefined;
    });

    expect(() => {
      resolvePending({
        ok: true,
        trace_id: 'tr-unmount',
        data: {
          source: 'system',
          path: 'data/logs/system.log',
          exists: true,
          text: 'after unmount',
        },
      });
    }).not.toThrow();
  });
});
