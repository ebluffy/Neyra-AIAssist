'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Cpu, RefreshCw } from 'lucide-react';
import { ModuleCard, type ModuleInfo } from '../../../components/ui/ModuleCard';
import { Button } from '../../../components/ui/Button';
import { emitToast } from '../../../lib/toast';

const INITIAL_MODULES: ModuleInfo[] = [
  {
    id: 'llm-gateway',
    name: 'LLM Gateway',
    description: 'Маршрутизация обращений к внешним и локальным провайдерам моделей с fallback',
    status: 'online',
    enabled: true,
    latencyMs: 14,
    version: '2.4.1',
  },
  {
    id: 'memory-engine',
    name: 'Memory Engine',
    description: 'Долговременная семантическая память и извлечение фактов пользователя (person_id)',
    status: 'online',
    enabled: true,
    latencyMs: 8,
    version: '2.1.0',
  },
  {
    id: 'stt-service',
    name: 'STT (Распознавание речи)',
    description: 'Серверная транскрибация входящих голосовых сообщений и аудиопотока',
    status: 'degraded',
    enabled: true,
    latencyMs: 120,
    version: '1.8.3',
  },
  {
    id: 'tts-service',
    name: 'TTS (Синтез речи)',
    description: 'Голосовой синтез ответов ассистента с потоковой передачей в клиент',
    status: 'online',
    enabled: true,
    latencyMs: 45,
    version: '1.9.0',
  },
  {
    id: 'vision-analyzer',
    name: 'Vision & Multimodal',
    description: 'Извлечение текста, распознавание изображений и анализ прикреплённых файлов',
    status: 'online',
    enabled: true,
    latencyMs: 32,
    version: '2.0.2',
  },
  {
    id: 'scheduler',
    name: 'Task Scheduler',
    description: 'Фоновые периодические задачи ядра, ротация логов и очистка вложений по TTL',
    status: 'online',
    enabled: true,
    latencyMs: 2,
    version: '1.2.0',
  },
];

export default function AdminModulesPage() {
  const [modules, setModules] = useState<ModuleInfo[]>(INITIAL_MODULES);
  const [refreshing, setRefreshing] = useState(false);

  const handleToggle = (id: string, enabled: boolean) => {
    setModules((prev) =>
      prev.map((m) => (m.id === id ? { ...m, enabled, status: enabled ? 'online' : 'offline' } : m))
    );
    emitToast({
      message: `Модуль ${id} ${enabled ? 'включен' : 'отключен'}`,
      tone: 'info',
    });
  };

  const handleRefresh = () => {
    setRefreshing(true);
    setTimeout(() => {
      setRefreshing(false);
      emitToast({ message: 'Статусы модулей обновлены', tone: 'success' });
    }, 400);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/chat?settings=system"
            className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors"
            aria-label="Назад в админку"
          >
            <ArrowLeft size={16} />
          </Link>
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text)] flex items-center gap-2">
              <Cpu size={16} className="text-[var(--accent)]" />
              <span>Подсистемы ядра (Ops Modules)</span>
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Управление активными модулями и мониторинг состояния сервисов ядра neyra-core
            </p>
          </div>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          loading={refreshing}
          disabled={refreshing}
          className="text-xs gap-1.5"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          <span>Проверить статус</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {modules.map((m) => (
          <ModuleCard key={m.id} module={m} onToggle={handleToggle} />
        ))}
      </div>
    </div>
  );
}
