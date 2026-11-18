// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  ModelPicker,
  BranchTree,
  ReasoningPanel,
  UsageCostBadge,
  MemoryFactCard,
  MemorySearch,
  MemoryEmptyState,
  ModuleCard,
  WebhookRow,
  BackupRow,
  VoicePanel,
  LegacyNotice,
  ExportMenu,
  ShareDialog,
} from './index';

describe('Design System P0–P6 Components', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('ModelPicker (P1)', () => {
    it('renders current default model name and toggles dropdown', () => {
      render(<ModelPicker selectedModelId="neyra" />);
      const button = screen.getByRole('button', { name: /Выбор модели/i });
      expect(button).toBeTruthy();
      expect(screen.getByText('Нейра')).toBeTruthy();

      // Open dropdown
      fireEvent.click(button);
      expect(screen.getByRole('listbox')).toBeTruthy();
      expect(screen.getByText('GPT-4o')).toBeTruthy();
      expect(screen.getByText('Claude 3.5 Sonnet')).toBeTruthy();
      expect(screen.getAllByText('Скоро').length).toBeGreaterThan(0);
    });

    it('does not switch to non-default model and explains limitation (§15 п. 4)', () => {
      const onSelect = vi.fn();
      render(<ModelPicker selectedModelId="neyra" onSelectModel={onSelect} />);
      const button = screen.getByRole('button', { name: /Выбор модели/i });
      fireEvent.click(button);

      const gptOption = screen.getByText('GPT-4o').closest('[role="option"]');
      expect(gptOption).toBeTruthy();
      fireEvent.click(gptOption!);

      // Should not call onSelect for models not yet supported for per-turn override
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('BranchTree (P1)', () => {
    it('returns null if there is only 1 branch', () => {
      const { container } = render(<BranchTree currentBranchIndex={0} totalBranches={1} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders navigation controls and handles page clicks', () => {
      const onSelect = vi.fn();
      render(<BranchTree currentBranchIndex={0} totalBranches={3} onSelectBranch={onSelect} />);

      expect(screen.getByText('1 / 3')).toBeTruthy();
      const prevBtn = screen.getByRole('button', { name: 'Предыдущая ветка' });
      const nextBtn = screen.getByRole('button', { name: 'Следующая ветка' });

      expect((prevBtn as HTMLButtonElement).disabled).toBe(true);
      expect((nextBtn as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(nextBtn);
      expect(onSelect).toHaveBeenCalledWith(1);
    });
  });

  describe('ReasoningPanel (P1)', () => {
    it('renders collapsed by default and expands on click', () => {
      render(
        <ReasoningPanel
          content="Детальные размышления модели..."
          durationSeconds={2.4}
        />
      );

      expect(screen.getByText(/Размышления \(2.4 с\)/)).toBeTruthy();
      expect(screen.queryByText('Детальные размышления модели...')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /Размышления/ }));
      expect(screen.getByText('Детальные размышления модели...')).toBeTruthy();
    });
  });

  describe('UsageCostBadge (P1/P3)', () => {
    it('renders formatted token count and cost estimate (§15 п. 10)', () => {
      render(
        <UsageCostBadge
          totalTokens={1240}
          promptTokens={1000}
          completionTokens={240}
          estimatedCostUsd={0.0025}
        />
      );

      expect(screen.getByText('1.2k токенов')).toBeTruthy();
      expect(screen.getByText('~$0.0025')).toBeTruthy();
    });
  });

  describe('MemoryFactCard (P2)', () => {
    it('renders fact text, category, and date', () => {
      const fact = {
        id: 'f-1',
        fact: 'Пользователь предпочитает темную тему',
        category: 'предпочтение',
        createdAt: '2026-11-15T12:00:00Z',
        confidence: 0.95,
      };

      render(<MemoryFactCard fact={fact} canDelete onDelete={vi.fn()} />);
      expect(screen.getByText('Пользователь предпочитает темную тему')).toBeTruthy();
      expect(screen.getByText('предпочтение')).toBeTruthy();
      expect(screen.getByText('Уверенность: 95%')).toBeTruthy();
    });
  });

  describe('MemorySearch (P2)', () => {
    it('allows searching and switching scopes', () => {
      const onQuery = vi.fn();
      const onScope = vi.fn();

      render(
        <MemorySearch
          query="test"
          onQueryChange={onQuery}
          scope="all"
          onScopeChange={onScope}
        />
      );

      const input = screen.getByPlaceholderText(/Поиск по сохранённой памяти/);
      expect(input).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Факты' }));
      expect(onScope).toHaveBeenCalledWith('facts');
    });
  });

  describe('ModuleCard (P4)', () => {
    it('renders module title, latency, and toggles switch', () => {
      const onToggle = vi.fn();
      const module = {
        id: 'llm-gw',
        name: 'LLM Gateway',
        description: 'Шлюз обращений к моделям',
        status: 'online' as const,
        enabled: true,
        latencyMs: 14,
      };

      render(<ModuleCard module={module} onToggle={onToggle} />);
      expect(screen.getByText('LLM Gateway')).toBeTruthy();
      expect(screen.getByText('В сети')).toBeTruthy();
      expect(screen.getByText(/14 мс/)).toBeTruthy();

      const toggle = screen.getByRole('switch');
      fireEvent.click(toggle);
      expect(onToggle).toHaveBeenCalledWith('llm-gw', false);
    });
  });

  describe('VoicePanel (P5)', () => {
    it('renders visualizer and handles start/stop callbacks', () => {
      const onStart = vi.fn();
      const onStop = vi.fn();

      const { rerender } = render(
        <VoicePanel state="idle" onStartListening={onStart} onStopListening={onStop} />
      );

      expect(screen.getByText('Ожидание')).toBeTruthy();
      const startBtn = screen.getByRole('button', { name: /Начать разговор/i });
      fireEvent.click(startBtn);
      expect(onStart).toHaveBeenCalled();

      rerender(
        <VoicePanel state="listening" onStartListening={onStart} onStopListening={onStop} />
      );

      expect(screen.getByText('Слушаю...')).toBeTruthy();
      const stopBtn = screen.getByRole('button', { name: /Остановить запись/i });
      fireEvent.click(stopBtn);
      expect(onStop).toHaveBeenCalled();
    });

    it('AR-84: disables button in unsupported state and does not pretend to be active', () => {
      render(<VoicePanel state="unsupported" />);
      const btn = screen.getByRole('button', { name: /Начать разговор/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(screen.getByText(/Голосовой режим появится после калибровки шлюза/)).toBeTruthy();
    });
  });

  describe('ExportMenu (P5)', () => {
    it('renders export menu and triggers export format', () => {
      const onExport = vi.fn();
      render(<ExportMenu onExport={onExport} />);

      const trigger = screen.getByRole('button', { name: 'Экспорт диалога' });
      fireEvent.click(trigger);

      expect(screen.getByRole('menu')).toBeTruthy();
      fireEvent.click(screen.getByRole('menuitem', { name: /Markdown/i }));
      expect(onExport).toHaveBeenCalledWith('markdown');
    });

    it('AR-84: shows soonToast instead of fake success toast when onExport is absent', async () => {
      const toastModule = await import('../../lib/toast');
      const spy = vi.spyOn(toastModule, 'soonToast');

      render(<ExportMenu />);
      const trigger = screen.getByRole('button', { name: 'Экспорт диалога' });
      fireEvent.click(trigger);

      fireEvent.click(screen.getByRole('menuitem', { name: /Markdown/i }));
      expect(spy).toHaveBeenCalledWith('Экспорт в MARKDOWN');
    });
  });

  describe('ShareDialog (P5)', () => {
    it('AR-87: shows honest soon action and disables generation when no server link or handler is present', () => {
      render(
        <ShareDialog
          open={true}
          onClose={vi.fn()}
          threadId="thread-1"
          threadTitle="Тестовый диалог"
        />
      );

      expect(screen.getByText('Поделиться диалогом')).toBeTruthy();
      const btn = screen.getByRole('button', { name: /Сформировать ссылку \(Скоро\)/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(screen.queryByDisplayValue(/sh_/)).toBeNull();
    });

    it('AR-87: renders server-provided shareUrl without generating fake tokens', () => {
      render(
        <ShareDialog
          open={true}
          onClose={vi.fn()}
          threadId="thread-1"
          shareUrl="https://neyra.owyx.site/share/token-from-server-crypto-32b"
        />
      );

      const input = screen.getByDisplayValue('https://neyra.owyx.site/share/token-from-server-crypto-32b');
      expect(input).toBeTruthy();
      expect(screen.getByRole('button', { name: /Копировать/i })).toBeTruthy();
    });
  });

  describe('LegacyNotice (P6)', () => {
    it('renders migration explanation and navigation button', () => {
      render(<LegacyNotice />);
      expect(screen.getByText(/Устаревший интерфейс управления/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Перейти в панель управления/i })).toBeTruthy();
    });
  });

  describe('AR-92 & AR-93 Token and Spacing Compliance', () => {
    it('AR-92: ModuleCard uses semantic var(--warning) token for degraded status', () => {
      const { container } = render(
        <ModuleCard
          module={{
            id: 'mod-1',
            name: 'Voice Gateway',
            status: 'degraded',
            enabled: true,
            description: 'Тестовый модуль',
          }}
        />
      );
      const dot = container.querySelector('.bg-\\[var\\(--warning\\)\\]');
      expect(dot).toBeTruthy();
    });

    it('AR-93: WebhookRow and BackupRow use valid py-0.5 class and do not contain dead py-0.2', () => {
      const { container: whContainer } = render(
        <WebhookRow
          webhook={{
            id: 'wh-1',
            url: 'https://example.com/webhook',
            active: true,
            events: ['message.created'],
          }}
        />
      );
      expect(whContainer.innerHTML).toContain('py-0.5');
      expect(whContainer.innerHTML).not.toContain('py-0.2');

      const { container: bkContainer } = render(
        <BackupRow
          backup={{
            id: 'bk-1',
            filename: 'core-dump.tar.gz',
            sizeBytes: 1048576,
            createdAt: '2026-11-17T12:00:00Z',
            type: 'auto',
          }}
        />
      );
      expect(bkContainer.innerHTML).toContain('py-0.5');
      expect(bkContainer.innerHTML).not.toContain('py-0.2');
    });
  });
});
