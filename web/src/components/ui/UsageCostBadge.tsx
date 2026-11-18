'use client';

import React from 'react';
import { Coins } from 'lucide-react';
import { Tooltip } from './Tooltip';

export interface UsageCostBadgeProps {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
  className?: string;
}

export function UsageCostBadge({
  totalTokens,
  promptTokens,
  completionTokens,
  estimatedCostUsd,
  className = '',
}: UsageCostBadgeProps) {
  if (typeof totalTokens !== 'number' && typeof estimatedCostUsd !== 'number') {
    return null;
  }

  const formattedTokens =
    typeof totalTokens === 'number'
      ? totalTokens >= 1000
        ? `${(totalTokens / 1000).toFixed(1)}k токенов`
        : `${totalTokens} токенов`
      : null;

  const formattedCost =
    typeof estimatedCostUsd === 'number'
      ? estimatedCostUsd < 0.01
        ? `~$${estimatedCostUsd.toFixed(4)}`
        : `~$${estimatedCostUsd.toFixed(2)}`
      : null;

  const tooltipDetails = [
    typeof promptTokens === 'number' ? `Вход: ${promptTokens}` : null,
    typeof completionTokens === 'number' ? `Выход: ${completionTokens}` : null,
    typeof totalTokens === 'number' ? `Всего: ${totalTokens}` : null,
    formattedCost ? `Оценка стоимости: ${formattedCost} (§15 п. 10)` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Tooltip content={tooltipDetails || 'Использование ресурсов'}>
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] font-mono text-[11px] text-[var(--text-subtle)] select-none ${className}`}
      >
        <Coins size={11} className="text-[var(--text-subtle)]" />
        {formattedTokens && <span>{formattedTokens}</span>}
        {formattedTokens && formattedCost && <span>·</span>}
        {formattedCost && <span>{formattedCost}</span>}
      </span>
    </Tooltip>
  );
}
