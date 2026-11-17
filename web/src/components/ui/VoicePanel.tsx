'use client';

import React, { useState } from 'react';
import { Mic, MicOff, Volume2, Radio, AlertCircle } from 'lucide-react';
import { Button } from './Button';

export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking' | 'unsupported';

export interface VoicePanelProps {
  state?: VoiceState;
  onStartListening?: () => void;
  onStopListening?: () => void;
  transcript?: string;
  errorMessage?: string;
  isContinuousMode?: boolean;
  onToggleContinuous?: (enabled: boolean) => void;
  className?: string;
}

export function VoicePanel({
  state = 'idle',
  onStartListening,
  onStopListening,
  transcript = '',
  errorMessage,
  isContinuousMode = false,
  onToggleContinuous,
  className = '',
}: VoicePanelProps) {
  const isListening = state === 'listening';
  const isProcessing = state === 'processing';
  const isSpeaking = state === 'speaking';

  return (
    <div
      className={`p-5 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-4 text-center select-none ${className}`}
    >
      <div className="flex items-center justify-between text-xs text-[var(--text-subtle)]">
        <span className="font-semibold uppercase tracking-wider text-[10px]">
          Голосовой интерфейс
        </span>
        <span className="flex items-center gap-1 font-mono text-[11px]">
          <Radio size={12} className={isListening ? 'text-[var(--success)] animate-pulse' : 'text-[var(--text-subtle)]'} />
          {state === 'idle' && 'Ожидание'}
          {state === 'listening' && 'Слушаю...'}
          {state === 'processing' && 'Обработка...'}
          {state === 'speaking' && 'Воспроизведение...'}
          {state === 'unsupported' && 'Не поддерживается'}
        </span>
      </div>

      {/* Visualizer bars */}
      <div className="h-16 flex items-center justify-center gap-1.5 px-4 bg-[var(--surface)] rounded-[var(--radius-sm)] border border-[var(--border)]">
        {Array.from({ length: 12 }).map((_, idx) => {
          const heights = [20, 35, 60, 80, 45, 90, 70, 40, 65, 85, 50, 25];
          const activeHeight = isListening || isSpeaking ? heights[idx % heights.length] : 8;
          return (
            <div
              key={idx}
              style={{ height: `${activeHeight}%` }}
              className={`w-1 rounded-full transition-all duration-150 ${
                isListening
                  ? 'bg-[var(--accent)]'
                  : isSpeaking
                  ? 'bg-emerald-400'
                  : 'bg-[var(--surface-3)]'
              }`}
            />
          );
        })}
      </div>

      {/* Transcript feedback */}
      <div className="min-h-[36px] flex items-center justify-center">
        {transcript ? (
          <p className="text-xs text-[var(--text)] italic leading-relaxed max-w-sm">
            «{transcript}»
          </p>
        ) : errorMessage ? (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1 justify-center">
            <AlertCircle size={12} />
            <span>{errorMessage}</span>
          </p>
        ) : state === 'unsupported' ? (
          <p className="text-xs text-[var(--text-subtle)]">
            Голосовой режим появится после калибровки шлюза в P5
          </p>
        ) : (
          <p className="text-xs text-[var(--text-subtle)]">
            {isListening
              ? 'Говорите — распознавание в реальном времени...'
              : 'Нажмите кнопку или используйте Push-to-Talk для начала разговора'}
          </p>
        )}
      </div>

      {/* Control buttons */}
      <div className="flex items-center justify-center gap-3">
        <Button
          variant={isListening ? 'primary' : 'secondary'}
          size="md"
          onClick={isListening ? onStopListening : onStartListening}
          disabled={state === 'unsupported' || state === 'processing' || (!isListening && !onStartListening)}
          className="gap-2 px-6 h-11"
        >
          {isListening ? (
            <>
              <MicOff size={16} />
              <span>Остановить запись</span>
            </>
          ) : (
            <>
              <Mic size={16} />
              <span>Начать разговор</span>
            </>
          )}
        </Button>
      </div>

      <div className="pt-2 border-t border-[var(--border)] text-[11px] text-[var(--text-subtle)] flex items-center justify-center gap-2">
        <span>Серверный STT/TTS (§15 п. 8)</span>
      </div>
    </div>
  );
}
