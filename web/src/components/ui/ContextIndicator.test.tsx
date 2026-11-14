// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContextIndicator, formatTokenCount } from './ContextIndicator';

afterEach(() => {
  cleanup();
});

describe('ContextIndicator', () => {
  it('formats token count correctly', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(138_600)).toBe('138,6 тыс.');
    expect(formatTokenCount(1_000_000)).toBe('1 млн');
    expect(formatTokenCount(2_500_000)).toBe('2,5 млн');
  });

  it('renders nothing when usage is null or undefined (spec §5.2)', () => {
    const { container: c1 } = render(<ContextIndicator usage={null} />);
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(<ContextIndicator usage={undefined} />);
    expect(c2.firstChild).toBeNull();
  });

  it('renders popover without auto-compaction string when neither policy nor threshold_pct is provided', () => {
    const onNewChat = vi.fn();

    render(
      <ContextIndicator
        usage={{
          total: { used: 138_600, limit: 1_000_000 },
          lanes: {
            brain: { used: 60_000, limit: 500_000 },
            talk: { used: 50_000, limit: 250_000 },
            vision: { used: 15_000, limit: 150_000 },
            memory: { used: 13_600, limit: 100_000 },
          },
        }}
        onNewChat={onNewChat}
      />
    );

    // Initial pill view
    expect(screen.getByText('Контекст · 14%')).toBeTruthy();

    // Open popover
    fireEvent.click(screen.getByRole('button', { name: /контекст диалога/i }));

    expect(screen.getByText('Контекст диалога')).toBeTruthy();
    expect(screen.getByText('138,6 тыс. из 1 млн токенов')).toBeTruthy();
    expect(screen.getByText('Лейны контекста')).toBeTruthy();

    // Lanes present
    expect(screen.getByText('Рассуждения (Brain)')).toBeTruthy();
    expect(screen.getByText('Диалог (Talk)')).toBeTruthy();
    expect(screen.getByText('Изображения (Vision)')).toBeTruthy();
    expect(screen.getByText('Память (Memory)')).toBeTruthy();

    // No hardcoded 80% or auto-compaction string when absent in usage/policy
    expect(screen.queryByText(/порог/i)).toBeNull();
    expect(screen.queryByText(/автосжати/i)).toBeNull();
    expect(screen.queryByText('Сжать сейчас')).toBeNull();

    // New chat button is present
    const newChatBtn = screen.getByText('Новый чат');
    fireEvent.click(newChatBtn);
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it('renders "Автосжатие выключено" when policy compaction_enabled is false or mode is off', () => {
    render(
      <ContextIndicator
        usage={{
          total: { used: 138_600, limit: 1_000_000 },
          policy: {
            compaction_enabled: false,
            mode: 'off',
          },
          lanes: {
            brain: { used: 60_000, limit: 500_000 },
            talk: { used: 50_000, limit: 250_000 },
            vision: { used: 15_000, limit: 150_000 },
            memory: { used: 13_600, limit: 100_000 },
          },
        }}
      />
    );

    // Open popover
    fireEvent.click(screen.getByRole('button', { name: /контекст диалога/i }));

    expect(screen.getByText('Автосжатие выключено')).toBeTruthy();
    expect(screen.queryByText(/порог/i)).toBeNull();
  });

  it('renders only lanes with both used and limit from the kernel', () => {
    render(
      <ContextIndicator
        usage={{
          total: { used: 100, limit: 1_000 },
          lanes: {
            talk: { used: 60, limit: 300 },
            brain: { limit: 500 },
            memory: { used: 40 },
          },
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /контекст диалога/i }));

    expect(screen.getByText('Диалог (Talk)')).toBeTruthy();
    expect(screen.queryByText('Рассуждения (Brain)')).toBeNull();
    expect(screen.queryByText('Память (Memory)')).toBeNull();
    expect(screen.queryByText(/порог/i)).toBeNull();
  });

  it('hides itself when the kernel sent no total used/limit pair', () => {
    const { container } = render(<ContextIndicator usage={{ lanes: { talk: { used: 10, limit: 100 } } }} />);
    expect(container.firstChild).toBeNull();
  });
});
