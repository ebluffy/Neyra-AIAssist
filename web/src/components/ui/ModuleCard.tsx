'use client';

import React from 'react';
import { Activity, Power, Cpu, AlertTriangle } from 'lucide-react';
import { Switch } from './Switch';

export type ModuleStatus = 'online' | 'degraded' | 'offline';

export interface ModuleInfo {
  id: string;
  name: string;
  description: string;
  status: ModuleStatus;
  enabled: boolean;
  latencyMs?: number;
  version?: string;
}

export interface ModuleCardProps {
  module: ModuleInfo;
  onToggle?: (id: string, enabled: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function ModuleCard({
  module,
  onToggle,
  disabled = false,
  className = '',
}: ModuleCardProps) {
  const statusColors: Record<ModuleStatus, { dot: string; label: string }> = {
    online: { dot: 'bg-emerald-500', label: 'В сети' },
    degraded: { dot: 'bg-amber-500', label: 'Деградация' },
    offline: { dot: 'bg-zinc-600', label: 'Выключен' },
  };

  const statusConfig = statusColors[module.status] || statusColors.offline;

  return (
    <div
      className={`p-4 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-3 transition-colors ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)] text-[var(--text)]">
            <Cpu size={16} />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-[var(--text)]">{module.name}</h4>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${statusConfig.dot}`} />
              <span className="text-[11px] text-[var(--text-muted)]">{statusConfig.label}</span>
              {typeof module.latencyMs === 'number' && (
                <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                  · {module.latencyMs} мс
                </span>
              )}
            </div>
          </div>
        </div>

        <Switch
          checked={module.enabled}
          onChange={(checked) => onToggle?.(module.id, checked)}
          disabled={disabled}
          label={`Переключить модуль ${module.name}`}
        />
      </div>

      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        {module.description}
      </p>

      {module.version && (
        <div className="pt-2 border-t border-[var(--border)] flex items-center justify-between text-[11px] text-[var(--text-subtle)] font-mono">
          <span>ID: {module.id}</span>
          <span>v{module.version}</span>
        </div>
      )}
    </div>
  );
}
