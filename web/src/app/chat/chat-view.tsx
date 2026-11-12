'use client';

import React, { useState, useRef, type FormEvent, useEffect } from 'react';
import Link from 'next/link';
import { Button, Badge } from '@neyra/ui';
import { ru } from '../../i18n';

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

export function ChatView({
  user,
}: {
  user: { id: string; email?: string | null; name?: string | null; role?: string | null };
}) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStreaming(false);
    setThinking(false);
    setMessages(prev =>
      prev.map(m => (m.pending ? { ...m, pending: false } : m))
    );
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    setError('');
    setInput('');

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user', content: text },
      { id: assistantMsgId, role: 'assistant', content: '', pending: true },
    ]);

    setThinking(true);
    setStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errDesc = `Ошибка сервера (HTTP ${response.status})`;
        try {
          const errData = await response.json();
          if (errData?.message) errDesc = errData.message;
          else if (errData?.error) errDesc = errData.error;
        } catch {
          // non-JSON error
        }
        setError(errDesc);
        setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
        return;
      }

      if (!response.body) {
        setError('Сервер не вернул поток ответа.');
        setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'token') {
              setThinking(false);
              assistantText += event.text ?? '';
              const updatedText = assistantText;
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantMsgId ? { ...m, content: updatedText } : m
                )
              );
            } else if (event.type === 'thinking') {
              setThinking(true);
            } else if (event.type === 'done') {
              setThinking(false);
              if (event.text) {
                assistantText = event.text;
                setMessages(prev =>
                  prev.map(m =>
                    m.id === assistantMsgId
                      ? { ...m, content: event.text, pending: false }
                      : m
                  )
                );
              }
            } else if (event.type === 'error') {
              setThinking(false);
              const errMsg = event.message || event.code || 'Неизвестная ошибка модели';
              setError(`Ошибка ядра: ${errMsg}`);
            }
          } catch {
            // Игнорируем сырые фрагменты, не являющиеся JSON
          }
        }
      }

      setMessages(prev =>
        prev.map(m => (m.id === assistantMsgId ? { ...m, pending: false } : m))
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Остановлено пользователем по кнопке "Стоп"
      } else {
        setError(ru.networkError);
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col p-4 md:p-6">
      <header className="flex items-center justify-between border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm underline">
            {ru.toHome}
          </Link>
          <h1 className="text-lg font-semibold">{ru.chat}</h1>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[var(--muted)]">{user.name || user.email}</span>
          {user.role && <Badge className="border border-[var(--border)] px-2 py-0.5 rounded">{user.role}</Badge>}
        </div>
      </header>

      <section
        className="flex-1 overflow-y-auto space-y-4 py-4"
        aria-label="Сообщения чата"
      >
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
            {ru.emptyChat}
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            <span className="text-xs text-[var(--muted)] mb-1">
              {msg.role === 'user' ? ru.userRole : ru.assistantRole}
            </span>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-[var(--foreground)] text-[var(--background)]'
                  : 'bg-[var(--border)] text-[var(--foreground)]'
              }`}
            >
              {msg.content || (msg.pending ? '…' : '')}
            </div>
          </div>
        ))}

        {thinking && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)] animate-pulse" role="status">
            <span>{ru.thinking}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </section>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-red-700 bg-red-950/50 p-3 text-xs text-red-200"
        >
          {error}
        </div>
      )}

      <footer className="border-t border-[var(--border)] pt-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={ru.placeholder}
            disabled={streaming}
            className="flex-1"
            aria-label="Сообщение"
          />
          {streaming ? (
            <Button
              type="button"
              onClick={stopGeneration}
              className="bg-red-800 hover:bg-red-700 text-white"
            >
              {ru.stop}
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              {ru.send}
            </Button>
          )}
        </form>
      </footer>
    </main>
  );
}
