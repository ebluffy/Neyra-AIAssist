// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextIndicator, formatTokenCount } from './ContextIndicator';

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

  it('renders percentage and opens popover with lanes breakdown and no manual compact button', () => {
    const onNewChat = vi.fn();

    render(
      <ContextIndicator
        usage={{
          prompt_tokens: 100_000,
          completion_tokens: 38_600,
          context_used: 138_600,
          context_limit: 1_000_000,
          lanes: {
            brain: { used: 60_000, limit: 500_000, threshold_pct: 80 },
            talk: { used: 50_000, limit: 250_000, threshold_pct: 80 },
            vision: { used: 15_000, limit: 150_000, threshold_pct: 80 },
            memory: { used: 13_600, limit: 100_000, threshold_pct: 80 },
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

    // Manual compact button must NOT exist
    expect(screen.queryByText('Сжать сейчас')).toBeNull();

    // New chat action exists
    const newChatBtn = screen.getByText('Новый чат');
    fireEvent.click(newChatBtn);
    expect(onNewChat).toHaveBeenCalledOnce();
  });
});
