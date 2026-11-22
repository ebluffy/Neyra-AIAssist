// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TurnStatsFooter,
  formatDurationMs,
  formatModelName,
  formatTokensPerSecond,
} from './turn-stats';

afterEach(cleanup);

const stats = {
  duration_ms: 8400,
  llm_ms: 7200,
  output_tokens: 240,
  tokens_per_second: 33.3,
  model: 'opencode-go/deepseek-v4.1-flash',
  lanes: {
    brain: { calls: 1, duration_ms: 3100 },
    talk: { calls: 1, duration_ms: 2600, output_tokens: 240 },
    memory: { calls: 2, duration_ms: 1500 },
  },
};

describe('turn stats footer', () => {
  it('formats duration, model and speed for the subtitle', () => {
    expect(formatDurationMs(8400)).toBe('8,4 с');
    expect(formatDurationMs(62000)).toBe('1 мин 2 с');
    expect(formatDurationMs(120)).toBe('120 мс');
    expect(formatModelName('opencode-go/deepseek-v4.1-flash')).toBe('Deepseek V4.1 Flash');
    expect(formatTokensPerSecond(33.3)).toBe('33,3 ток/с');
  });

  it('shows the subtitle and expands per-lane timings', () => {
    const { container } = render(<TurnStatsFooter stats={stats} />);
    expect(screen.getByText('Deepseek V4.1 Flash')).toBeTruthy();
    expect(screen.getByText('8,4 с')).toBeTruthy();
    expect(screen.getByText('33,3 ток/с')).toBeTruthy();
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText('Использовано'));
    expect(details?.open).toBe(true);
    expect(screen.getByText('Мозг')).toBeTruthy();
    expect(screen.getByText('Разговор')).toBeTruthy();
    expect(screen.getByText('Память')).toBeTruthy();
    expect(screen.getByText(/2 вызова/)).toBeTruthy();
  });

  it('renders nothing when no lane has timing', () => {
    const { container } = render(<TurnStatsFooter stats={{ duration_ms: 10, llm_ms: 0, lanes: {} }} />);
    expect(container.innerHTML).toBe('');
  });
});
