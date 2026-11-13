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

  it('renders percentage and opens popover with actions when usage is present', () => {
    const onCompact = vi.fn();
    const onNewChat = vi.fn();

    render(
      <ContextIndicator
        usage={{
          prompt_tokens: 100_000,
          completion_tokens: 38_600,
          context_used: 138_600,
          context_limit: 1_000_000,
        }}
        onCompact={onCompact}
        onNewChat={onNewChat}
      />
    );

    // Initial pill view
    expect(screen.getByText('Контекст · 14%')).toBeTruthy();

    // Open popover
    fireEvent.click(screen.getByRole('button', { name: /контекст диалога/i }));

    expect(screen.getByText('Заполненность контекста')).toBeTruthy();
    expect(screen.getByText('138,6 тыс.')).toBeTruthy();
    expect(screen.getByText('из 1 млн токенов')).toBeTruthy();
    expect(screen.getByText('Контекст сжимается автоматически при 80%')).toBeTruthy();

    // Click "Сжать сейчас"
    fireEvent.click(screen.getByText('Сжать сейчас'));
    expect(onCompact).toHaveBeenCalledOnce();
  });
});
