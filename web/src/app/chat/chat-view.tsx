'use client';

import React, { useState, useRef, type FormEvent, useEffect, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Check,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Square,
  X,
} from 'lucide-react';
import { SseChatEventSchema } from '@neyra/contracts';
import { Button, IconButton, Chip, Avatar, NeyraLogo, MarkdownMessage } from '../../components/ui';
import { signOut } from '../../../lib/auth-client';
import { resolveChatId, resolveTabKey, resetChatId } from '../../../lib/chat-id';
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
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [lastUserMessage, setLastUserMessage] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Tab-scoped and user-bound chat id (§3, AR-1, AR-11)
  const [chatId, setChatId] = useState(() => {
    if (typeof window === 'undefined') return resolveChatId(null, 'ssr', user.id);
    return resolveChatId(window.sessionStorage, resolveTabKey(window), user.id);
  });

  // Leave page cancels active upstream connection
  useEffect(() => () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  // Close sidebar on Escape key
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Scroll detection for "Вниз" floating pill
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollDown(distanceToBottom > 120);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll when new messages arrive if near bottom
  useEffect(() => {
    if (!showScrollDown) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, thinking, showScrollDown]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '24px';
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 24), 144);
    textarea.style.height = `${newHeight}px`;
  }, [input]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollDown(false);
  };

  const startNewChat = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    const newId =
      typeof window === 'undefined'
        ? resolveChatId(null, 'ssr', user.id)
        : resetChatId(window.sessionStorage, resolveTabKey(window), user.id);
    setChatId(newId);
    setMessages([]);
    setError('');
    setThinking(false);
    setStreaming(false);
    setSidebarOpen(false);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

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

  const handleCopyMessage = async (msgId: string, content: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(content);
        setCopiedMessageId(msgId);
        setTimeout(() => setCopiedMessageId(null), 2000);
      }
    } catch {
      // Ignore
    }
  };

  const sendMessage = async (textToSend: string) => {
    const text = textToSend.trim();
    if (!text || streaming) return;

    setError('');
    setInput('');
    setLastUserMessage(text);

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
    let assistantText = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, chat_id: chatId }),
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
            const rawEvent = JSON.parse(jsonStr);
            const parsed = SseChatEventSchema.safeParse(rawEvent);
            if (!parsed.success) continue;
            const event = parsed.data;

            if (event.type === 'token') {
              setThinking(false);
              assistantText += event.text;
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
              setError(event.message || 'Ошибка обработки запроса.');
              if (!assistantText) {
                setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
              } else {
                setMessages(prev =>
                  prev.map(m =>
                    m.id === assistantMsgId ? { ...m, pending: false } : m
                  )
                );
              }
            }
          } catch {
            // Ignore non-json fragments
          }
        }
      }

      setMessages(prev =>
        prev.map(m => (m.id === assistantMsgId ? { ...m, pending: false } : m))
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Stopped by user
      } else {
        setError(ru.networkError);
        if (!assistantText) {
          setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
        }
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      abortControllerRef.current = null;
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      router.replace('/login');
      router.refresh();
    } catch {
      router.replace('/login');
    }
  };

  // Derive thread title for header
  const threadTitle = messages.length > 0
    ? messages.find(m => m.role === 'user')?.content.slice(0, 32) || 'Диалог'
    : ru.chat;

  return (
    <div className="flex h-screen w-full bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      {/* Mobile Drawer Backdrop (< 900px) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden backdrop-blur-sm transition-opacity"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar (264px) (§3) */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-[264px] bg-[var(--surface)] border-r border-[var(--border)] flex flex-col justify-between transition-transform duration-150 ease-out select-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
        aria-label="Боковая панель"
      >
        {/* Top: Logo & New Chat button */}
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <NeyraLogo size={24} />
              <span className="text-[16px] font-semibold tracking-tight text-[var(--text)]">Neyra</span>
            </div>
            <IconButton
              aria-label="Закрыть панель"
              icon={<X size={16} />}
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          </div>

          <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={startNewChat}
            className="w-full justify-start text-[13px] h-9 gap-2 px-3 bg-[var(--surface-2)]"
          >
            <Plus size={15} className="text-[var(--text-muted)]" />
            <span>{ru.newChat}</span>
          </Button>

          {/* Chat threads list (§3) */}
          <div className="pt-2 space-y-1">
            <div className="text-[11px] font-medium text-[var(--text-subtle)] px-2 pb-1 uppercase tracking-wider">
              Диалог
            </div>
            <div className="flex items-center gap-2.5 h-[34px] px-2.5 rounded-[var(--radius-sm)] bg-[var(--accent-quiet)] text-[var(--text)] border-l-2 border-[var(--accent)] text-[13px] font-medium truncate cursor-default">
              <MessageSquare size={14} className="text-[var(--accent)] shrink-0" />
              <span className="truncate">{threadTitle}</span>
            </div>
          </div>
        </div>

        {/* Bottom: User Card (§3) */}
        <div className="p-3 border-t border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Avatar name={user.name} email={user.email} size={24} />
            <div className="min-w-0 flex flex-col">
              <span className="text-xs font-medium text-[var(--text)] truncate">
                {user.name || user.email?.split('@')[0]}
              </span>
              <span className="text-[11px] text-[var(--text-muted)] truncate">
                {user.email}
              </span>
            </div>
            {user.role && (
              <span className="text-[10px] text-[var(--text-subtle)] border border-[var(--border)] rounded px-1.5 py-0.2 shrink-0">
                {user.role}
              </span>
            )}
          </div>

          <IconButton
            type="button"
            aria-label={ru.signOut}
            icon={<LogOut size={15} />}
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            title={ru.signOut}
            className="text-[var(--text-muted)] hover:text-[var(--text)] shrink-0"
          />
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Header 56px (§3) */}
        <header className="h-14 min-h-[56px] border-b border-[var(--border)] bg-[var(--bg)] px-4 flex items-center justify-between z-20">
          <div className="flex items-center gap-3 min-w-0">
            <IconButton
              type="button"
              aria-label="Открыть меню"
              icon={<PanelLeft size={18} />}
              variant="ghost"
              size="md"
              className="lg:hidden text-[var(--text-muted)]"
              onClick={() => setSidebarOpen(true)}
            />
            <h1 className="text-[15px] font-medium text-[var(--text)] truncate">
              {threadTitle}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors inline-flex items-center gap-1"
            >
              {ru.toHome}
            </Link>
          </div>
        </header>

        {/* Messages Feed (max 720px column) (§3) */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto px-4 md:px-6 py-6"
          aria-label="Сообщения чата"
        >
          <div className="content-column space-y-6">
            {/* Empty State (§3) */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center text-center pt-16 md:pt-24 pb-8 select-none">
                <NeyraLogo size={40} />
                <h2 className="text-[26px] md:text-[30px] font-semibold tracking-tight text-[var(--text)] mt-4 mb-2">
                  {ru.emptyChat}
                </h2>
                <p className="text-[14px] text-[var(--text-muted)] max-w-[380px] mb-8">
                  Задайте вопрос или выберите готовый сценарий для начала диалога:
                </p>

                <div className="flex flex-wrap items-center justify-center gap-2 max-w-[560px]">
                  <Chip onClick={() => sendMessage('Что нового в памяти?')}>
                    Что нового в памяти?
                  </Chip>
                  <Chip onClick={() => sendMessage('Суммируй вчерашний диалог')}>
                    Суммируй вчерашний диалог
                  </Chip>
                  <Chip onClick={() => sendMessage('Проверь состояние сервера')}>
                    Проверь состояние сервера
                  </Chip>
                </div>
              </div>
            )}

            {/* Conversation Messages */}
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex flex-col w-full ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                {msg.role === 'user' ? (
                  // User Message (§3: surface-2 bubble, right, max 78%)
                  <div className="flex flex-col items-end max-w-[78%]">
                    <span className="text-[11px] text-[var(--text-subtle)] mb-1 select-none">
                      {ru.userRole}
                    </span>
                    <div className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] px-3.5 py-2.5 text-[15px] leading-[24px] text-[var(--text)] whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  // Assistant Message (§3: NO bubble, article typography, full width)
                  <div className="w-full flex flex-col group relative">
                    <div className="text-[12px] font-medium text-[var(--text-subtle)] mb-1 select-none flex items-center justify-between">
                      <span>{ru.assistantRole}</span>
                      {msg.content && (
                        <button
                          type="button"
                          onClick={() => handleCopyMessage(msg.id, msg.content)}
                          aria-label={copiedMessageId === msg.id ? 'Скопировано' : 'Скопировать ответ'}
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-[var(--text-subtle)] hover:text-[var(--text)] flex items-center gap-1 text-[11px] p-1 rounded hover:bg-[var(--surface-3)] cursor-pointer"
                        >
                          {copiedMessageId === msg.id ? (
                            <Check size={12} className="text-[var(--success)]" />
                          ) : (
                            <Copy size={12} />
                          )}
                          <span>{copiedMessageId === msg.id ? 'Скопировано' : 'Копировать'}</span>
                        </button>
                      )}
                    </div>

                    <div className="text-[15px] leading-[24px] text-[var(--text)] w-full">
                      {msg.content ? (
                        <>
                          <MarkdownMessage content={msg.content} />
                          {msg.pending && (
                            <span
                              className="inline-block w-[2px] h-[1em] bg-[var(--accent)] ml-1 animate-pulse align-middle"
                              aria-hidden="true"
                            />
                          )}
                        </>
                      ) : msg.pending ? (
                        // Thinking 3-dots indicator (§3)
                        <div
                          className="flex items-center gap-1.5 py-2 text-[var(--text-subtle)]"
                          role="status"
                          aria-label={ru.thinking}
                        >
                          <span className="sr-only">{ru.thinking}</span>
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse"
                            style={{ animationDelay: '150ms' }}
                          />
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse"
                            style={{ animationDelay: '300ms' }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Error Banner (§3) */}
            {error && (
              <div
                role="alert"
                className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3.5 text-xs text-[var(--danger)] flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2">
                  <span>{error}</span>
                </div>
                {lastUserMessage && !streaming && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => sendMessage(lastUserMessage)}
                    className="shrink-0 h-7 text-[11px] px-2.5 gap-1"
                  >
                    <RefreshCw size={11} />
                    <span>Повторить</span>
                  </Button>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Scroll down floating pill (§3) */}
        {showScrollDown && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Прокрутить вниз"
            className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-full)] bg-[var(--surface-3)] border border-[var(--border-strong)] text-xs font-medium text-[var(--text)] shadow-lg hover:bg-[var(--surface-2)] transition-all cursor-pointer"
          >
            <ArrowDown size={13} />
            <span>Вниз</span>
          </button>
        )}

        {/* Sticky Composer (§3) */}
        <footer className="sticky bottom-0 z-20 bg-[var(--bg)]/90 backdrop-blur-md pt-2 pb-4 px-4 border-t border-transparent">
          <div className="content-column">
            <form onSubmit={handleSubmit} className="flex flex-col">
              <div className="relative rounded-[var(--radius-lg)] bg-[var(--surface-2)] border border-[var(--border)] p-2.5 pl-4 shadow-panel focus-within:border-[var(--accent)] transition-colors flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={ru.placeholder}
                  disabled={streaming}
                  rows={1}
                  aria-label="Сообщение"
                  className="flex-1 bg-transparent border-0 outline-none resize-none text-[15px] leading-[24px] text-[var(--text)] placeholder-[var(--text-subtle)] max-h-36 min-h-[24px] p-0 focus:ring-0"
                />

                {streaming ? (
                  <IconButton
                    type="button"
                    aria-label={ru.stop}
                    icon={<Square size={13} className="text-[var(--danger)] fill-current" />}
                    variant="secondary"
                    size="md"
                    rounded
                    onClick={stopGeneration}
                    className="shrink-0 bg-[var(--surface-3)] border-transparent hover:bg-[var(--surface-3)]"
                  />
                ) : (
                  <IconButton
                    type="submit"
                    aria-label={ru.send}
                    disabled={!input.trim()}
                    icon={<ArrowUp size={16} />}
                    variant={input.trim() ? 'primary' : 'ghost'}
                    size="md"
                    rounded
                    className={`shrink-0 transition-colors ${
                      input.trim()
                        ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                        : 'bg-[var(--surface-3)] text-[var(--text-subtle)]'
                    }`}
                  />
                )}
              </div>

              <div className="text-[11px] text-[var(--text-subtle)] text-center mt-1.5 select-none">
                Enter — отправить, Shift+Enter — новая строка
              </div>
            </form>
          </div>
        </footer>
      </div>
    </div>
  );
}
