'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Bot, ChevronDown, Check, Sparkles } from 'lucide-react';
import { Tooltip } from './Tooltip';

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description?: string;
  isDefault?: boolean;
}

const DEFAULT_MODELS: ModelOption[] = [
  {
    id: 'neyra',
    name: 'Нейра',
    provider: 'Ядро системы',
    description: 'Основная модель с доступом к памяти и инструментам',
    isDefault: true,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'OpenAI',
    description: 'Универсальная быстрая мультимодальная модель',
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    description: 'Глубокие рассуждения и анализ кода',
  },
  {
    id: 'llama-3-3-70b',
    name: 'Llama 3.3 70B',
    provider: 'Локальный хост (Ollama)',
    description: 'Локальная модель без отправки данных во внешний контур',
  },
];

export interface ModelPickerProps {
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ModelPicker({
  selectedModelId = 'neyra',
  onSelectModel,
  disabled = false,
  className = '',
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedModel =
    DEFAULT_MODELS.find((m) => m.id === selectedModelId) || DEFAULT_MODELS[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const handleSelect = (model: ModelOption) => {
    if (model.id !== 'neyra') {
      // Пока ядро поддерживает только глобальную модель (§15 п. 4)
      return;
    }
    onSelectModel?.(model.id);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative inline-block text-left ${className}`}>
      <Tooltip
        content={
          selectedModel.id === 'neyra'
            ? 'Модель по умолчанию: Нейра'
            : 'Скоро: смена модели по ходу диалога (контракт ядра §15 п. 4)'
        }
      >
        <button
          type="button"
          onClick={() => !disabled && setOpen((prev) => !prev)}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={`Выбор модели: ${selectedModel.name}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-[var(--radius-sm)] bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border-control)] hover:bg-[var(--surface-3)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Bot size={13} className="text-[var(--text-muted)]" />
          <span className="truncate max-w-[120px]">{selectedModel.name}</span>
          <ChevronDown
            size={12}
            className={`text-[var(--text-subtle)] transition-transform duration-150 ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>
      </Tooltip>

      {open && (
        <div
          role="listbox"
          aria-label="Список доступных моделей"
          className="absolute bottom-full mb-1 left-0 z-50 w-72 max-h-72 overflow-y-auto rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] shadow-[var(--shadow-panel)] p-1 text-[var(--text)] text-xs animate-in fade-in duration-100"
        >
          <div className="px-2 py-1.5 text-[10px] uppercase font-semibold text-[var(--text-subtle)] tracking-wider">
            Модели LLM
          </div>
          {DEFAULT_MODELS.map((model) => {
            const isSelected = model.id === selectedModel.id;
            const isCoreOnly = model.id !== 'neyra';
            return (
              <div
                key={model.id}
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(model)}
                className={`flex flex-col gap-0.5 px-2.5 py-2 rounded-[var(--radius-sm)] cursor-pointer select-none transition-colors ${
                  isCoreOnly
                    ? 'opacity-60 cursor-not-allowed hover:bg-transparent'
                    : isSelected
                    ? 'bg-[var(--surface-3)] text-[var(--accent)]'
                    : 'hover:bg-[var(--surface-3)] text-[var(--text)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-medium">
                    {model.isDefault && <Sparkles size={11} className="text-[var(--accent)]" />}
                    <span>{model.name}</span>
                  </div>
                  {isSelected && <Check size={12} className="text-[var(--accent)]" />}
                  {isCoreOnly && (
                    <span className="text-[10px] px-1 py-0.2 rounded border border-[var(--border)] text-[var(--text-subtle)]">
                      Скоро
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] flex items-center justify-between">
                  <span>{model.provider}</span>
                </div>
              </div>
            );
          })}
          <div className="mt-1 pt-1.5 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-subtle)] leading-normal">
            Смена модели для отдельных сообщений находится в разработке (§15 п. 4).
          </div>
        </div>
      )}
    </div>
  );
}
