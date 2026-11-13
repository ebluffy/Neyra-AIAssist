'use client';

import React, { useState, useRef, type FormEvent, useEffect, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Check,
  Edit2,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { SseChatEventSchema } from '@neyra/contracts';
import { Button, IconButton, Chip, Avatar, NeyraLogo, MarkdownMessage, ContextIndicator, AmbientBackground, type ContextUsage } from '../../components/ui';
import { signOut } from '../../../lib/auth-client';
import { resolveChatId, resolveTabKey, resetChatId } from '../../../lib/chat-id';
import { ru } from '../../i18n';

export interface ChatMessageAttachment {
  id: string;
  name: string;
  size: number;
  isImage: boolean;
}

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  error?: string | null;
  isRetrying?: boolean;
  attachments?: ChatMessageAttachment[];
}


function humanizeErrorMessage(rawError?: string | null): { message: string; hint?: string } {
  if (!rawError) return { message: 'Произошла ошибка при обработке запроса.' };
  const lower = rawError.toLowerCase();
  if (lower.includes('rate_limit') || lower.includes('ratelimit') || lower.includes('429') || lower.includes('лимит') || lower.includes('openai') || lower.includes('quota')) {
    return {
      message: 'Модель упёрлась в лимит провайдера — попробуйте позже.',
      hint: 'Сброс суточного лимита обычно происходит в 03:00 МСК.',
    };
  }
  if (lower.includes('context') || lower.includes('контекст') || lower.includes('length')) {
    return {
      message: 'Запрос слишком длинный для контекста модели.',
      hint: 'Попробуйте сократить текст или начать новый диалог.',
    };
  }
  if (lower.includes('timeout') || lower.includes('таймаут') || lower.includes('не ответило вовремя')) {
    return {
      message: 'Ядро Нейры не ответило вовремя.',
      hint: 'Попробуйте повторить запрос через несколько секунд.',
    };
  }
  if (lower.includes('unavailable') || lower.includes('недоступен') || lower.includes('connect')) {
    return {
      message: 'Провайдер или сервис модели временно недоступен.',
      hint: 'Попробуйте повторить запрос чуть позже.',
    };
  }
  // Незнакомую причину показываем как есть: ядро уже отдаёт наружу только
  // безопасные формулировки (сырой текст провайдера фильтруется на сервере).
  const text = rawError.trim().slice(0, 240);
  if (text) return { message: text };
  return {
    message: 'Не удалось подготовить ответ. Попробуйте ещё раз.',
    hint: 'Если ошибка повторяется, проверьте состояние ядра в админке.',
  };
}

export interface ChatViewProps {
  user: { id: string; email?: string | null; name?: string | null; role?: string | null };
  initialMessages?: ChatMessageItem[];
  initialUsage?: ContextUsage | null;
}

export function ChatView({
  user,
  initialMessages,
  initialUsage,
}: ChatViewProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessageItem[]>(() => initialMessages || []);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [lastUserMessage, setLastUserMessage] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  // Десктоп: сайдбар можно свернуть, чтобы чат занимал всё окно (§ волна 4).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // V2 UI states
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatMessageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(() => initialUsage || null);

  useEffect(() => {
    try {
      setSidebarCollapsed(window.localStorage.getItem('neyra:sidebar-collapsed') === '1');
    } catch {}
  }, []);

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Tab-scoped and user-bound chat id (§3, AR-1, AR-11)
  const [chatId, setChatId] = useState(() => {
    if (typeof window === 'undefined') return resolveChatId(null, 'ssr', user.id);
    return resolveChatId(window.sessionStorage, resolveTabKey(window), user.id);
  });

  // Support mock state from URL for screenshot testing
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const mockState = params.get('mockState');
    if (!mockState) return;

    if (mockState === 'streaming') {
      setMessages([
        { id: 'u1', role: 'user', content: 'Расскажи о возможностях Нейры' },
        { id: 'a1', role: 'assistant', content: '', pending: true },
      ]);
      setStreaming(true);
      setThinking(true);
    } else if (mockState === 'error') {
      setMessages([
        { id: 'u1', role: 'user', content: 'Проверь состояние сервисов' },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          error: 'Лимит запросов к модели исчерпан (провайдер временно ограничил доступ: OpenAIRateLimitError).',
        },
      ]);
    } else if (mockState === 'profile-user') {
      setProfileMenuOpen(true);
    } else if (mockState === 'profile-admin') {
      setProfileMenuOpen(true);
    } else if (mockState === 'attachments-menu') {
      setAttachMenuOpen(true);
    } else if (mockState === 'chips') {
      setAttachments([
        { id: 'att-1', name: 'report-2026.pdf', size: 1250000, isImage: false },
        { id: 'att-2', name: 'architecture.png', size: 450000, isImage: true },
      ]);
    } else if (mockState === 'context') {
      setUsage({
        prompt_tokens: 138600,
        completion_tokens: 1240,
        context_limit: 1000000,
        context_used: 139840,
        lanes: {
          brain: { used: 60000, limit: 500000 },
          talk: { used: 50000, limit: 250000 },
          vision: { used: 15000, limit: 150000 },
          memory: { used: 14840, limit: 100000 },
        },
      });
    } else if (mockState === 'context-policy-off') {
      setUsage({
        prompt_tokens: 138600,
        completion_tokens: 1240,
        context_limit: 1000000,
        context_used: 139840,
        policy: {
          compaction_enabled: false,
          mode: 'off',
        },
        lanes: {
          brain: { used: 60000, limit: 500000 },
          talk: { used: 50000, limit: 250000 },
          vision: { used: 15000, limit: 150000 },
          memory: { used: 14840, limit: 100000 },
        },
      });
    } else if (mockState === 'drawer') {
      setSidebarOpen(true);
    }
  }, []);

  // Leave page cancels active upstream connection
  useEffect(() => () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  // Keyboard navigation & global close on Escape
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
        setProfileMenuOpen(false);
        setAttachMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close menus on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (profileMenuRef.current && !profileMenuRef.current.contains(target) && !profileTriggerRef.current?.contains(target)) {
        setProfileMenuOpen(false);
      }
      if (attachMenuRef.current && !attachMenuRef.current.contains(target)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
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
    setThinking(false);
    setStreaming(false);
    setSidebarOpen(false);
    setAttachments([]);
    setAttachmentError(null);
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

  // Attachment handling (§3.2: limit 4 files, 8MB each)
  const handleFilesSelected = (files: FileList | null, isImage: boolean) => {
    setAttachMenuOpen(false);
    if (!files || files.length === 0) return;

    setAttachmentError(null);
    const maxFiles = 4;
    const maxSizeBytes = 8 * 1024 * 1024; // 8 MB

    if (attachments.length + files.length > maxFiles) {
      setAttachmentError(`Максимум ${maxFiles} файла(ов).`);
      return;
    }

    const newAttachments: ChatMessageAttachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > maxSizeBytes) {
        setAttachmentError(`Файл «${file.name}» превышает лимит 8 МБ.`);
        return;
      }
      newAttachments.push({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        isImage: isImage || file.type.startsWith('image/'),
      });
    }

    setAttachments(prev => [...prev, ...newAttachments]);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
    setAttachmentError(null);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  };

  // Helper to execute SSE request
  const executeChatRequest = async (
    textToSend: string,
    targetAssistantMsgId: string,
    currentAttachments: ChatMessageAttachment[]
  ) => {
    setThinking(true);
    setStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let assistantText = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: textToSend,
          chat_id: chatId,
          attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errDesc =
          response.status === 502 || response.status === 503
            ? 'Сервис Нейры временно недоступен. Попробуйте повторить запрос позже.'
            : `Ошибка сервера (HTTP ${response.status})`;
        try {
          const errData = await response.json();
          if (errData?.message) errDesc = errData.message;
          else if (errData?.error) errDesc = errData.error;
        } catch {
          // non-JSON error
        }
        setMessages(prev =>
          prev.map(m =>
            m.id === targetAssistantMsgId
              ? { ...m, pending: false, error: errDesc, isRetrying: false }
              : m
          )
        );
        return;
      }

      if (!response.body) {
        setMessages(prev =>
          prev.map(m =>
            m.id === targetAssistantMsgId
              ? { ...m, pending: false, error: 'Сервер не вернул поток ответа.', isRetrying: false }
              : m
          )
        );
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
                  m.id === targetAssistantMsgId
                    ? { ...m, content: updatedText, error: null, isRetrying: false, pending: true }
                    : m
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
                    m.id === targetAssistantMsgId
                      ? { ...m, content: event.text, pending: false, error: null, isRetrying: false }
                      : m
                  )
                );
              }
              // Extract usage if present in rawEvent
              if (rawEvent.usage && typeof rawEvent.usage === 'object') {
                setUsage(rawEvent.usage);
              }
            } else if (event.type === 'error') {
              setThinking(false);
              const errMsg = event.message || 'Ошибка обработки запроса.';
              setMessages(prev =>
                prev.map(m =>
                  m.id === targetAssistantMsgId
                    ? { ...m, pending: false, error: errMsg, isRetrying: false }
                    : m
                )
              );
            }
          } catch {
            // Ignore non-json fragments
          }
        }
      }

      setMessages(prev =>
        prev.map(m =>
          m.id === targetAssistantMsgId
            ? { ...m, pending: false, isRetrying: false }
            : m
        )
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Stopped by user
      } else {
        setMessages(prev =>
          prev.map(m =>
            m.id === targetAssistantMsgId
              ? { ...m, pending: false, error: ru.networkError, isRetrying: false }
              : m
          )
        );
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      abortControllerRef.current = null;
    }
  };

  const sendMessage = async (textToSend: string) => {
    const text = textToSend.trim();
    if (!text || streaming) return;

    setInput('');
    setLastUserMessage(text);
    const activeAttachments = [...attachments];
    setAttachments([]);
    setAttachmentError(null);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    setMessages(prev => [
      ...prev,
      { id: userMsgId, role: 'user', content: text, attachments: activeAttachments },
      { id: assistantMsgId, role: 'assistant', content: '', pending: true },
    ]);

    await executeChatRequest(text, assistantMsgId, activeAttachments);
  };

  // V2 Retry flow (§4.1): Reuses existing exchange, shows spinner in error block, no duplicate user message
  const handleRetry = async (assistantMsgId: string) => {
    if (streaming) return;

    const assistantIndex = messages.findIndex(m => m.id === assistantMsgId);
    if (assistantIndex === -1) return;

    // Find preceding user message
    let userText = lastUserMessage;
    let userAttachments: ChatMessageAttachment[] = [];
    for (let i = assistantIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userText = messages[i].content;
        userAttachments = messages[i].attachments || [];
        break;
      }
    }

    if (!userText) return;

    // Mark assistant message as retrying with spinner
    setMessages(prev =>
      prev.map(m =>
        m.id === assistantMsgId
          ? { ...m, isRetrying: true, content: '' }
          : m
      )
    );

    await executeChatRequest(userText, assistantMsgId, userAttachments);
  };

  // V2 Delete exchange (§4.1): Removes error and its preceding user message
  const handleDeleteExchange = (assistantMsgId: string) => {
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === assistantMsgId);
      if (idx === -1) return prev;
      if (idx > 0 && prev[idx - 1].role === 'user') {
        return prev.filter((_, i) => i !== idx && i !== idx - 1);
      }
      return prev.filter(m => m.id !== assistantMsgId);
    });
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

  // Keyboard navigation for profile menu
  const handleProfileMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setProfileMenuOpen(false);
      profileTriggerRef.current?.focus();
      return;
    }
    const items = profileMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;

    const currentIndex = Array.from(items).indexOf(document.activeElement as HTMLElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
      items[nextIndex]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      items[prevIndex]?.focus();
    }
  };

  // Derive thread title for header (truncated via CSS)
  const firstUserMsg = messages.find(m => m.role === 'user')?.content.trim();
  const threadTitle = customTitle || (messages.length > 0
    ? (firstUserMsg ? firstUserMsg.split('\n')[0] : 'Диалог')
    : ru.chat);

  return (
    <div className="relative flex h-screen w-full bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      <AmbientBackground />
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
        className={`relative z-10 fixed lg:static inset-y-0 left-0 z-50 w-[264px] bg-[var(--surface)] border-r border-[var(--border)] flex flex-col justify-between transition-transform duration-150 ease-out select-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${sidebarCollapsed ? 'lg:hidden' : ''}`}
        aria-label="Боковая панель"
      >
        {/* Top: Logo & New Chat button */}
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--radius-sm)]">
              <NeyraLogo size={24} />
              <span className="text-[16px] font-semibold tracking-tight text-[var(--text)]">Neyra</span>
            </Link>
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

          {/* Chat threads list */}
          <div className="pt-2 space-y-1">
            <div className="text-xs font-normal text-[var(--text-muted)] px-2 pb-1">
              Текущий диалог
            </div>
            <div className="flex items-center gap-2.5 h-[34px] px-2.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] text-[var(--text)] border-l-2 border-[var(--accent)] text-[13px] font-medium truncate cursor-default">
              <MessageSquare size={14} className="text-[var(--text)] shrink-0" />
              <span className="truncate">{threadTitle}</span>
            </div>
          </div>
        </div>

        {/* Bottom: User Card & Profile Popover (§5.1) */}
        <div className="relative p-3 border-t border-[var(--border)] bg-[var(--surface)]">
          <button
            ref={profileTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
            aria-label="Меню профиля пользователя"
            onClick={() => setProfileMenuOpen(prev => !prev)}
            className="w-full flex items-center justify-between gap-2 p-1.5 -m-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Avatar name={user.name} email={user.email} size={26} />
              <div className="min-w-0 flex flex-col">
                <span className="text-xs font-medium text-[var(--text)] truncate">
                  {user.name && user.name !== user.email ? user.name : user.email}
                </span>
              </div>
            </div>
            <span className="text-[10px] text-[var(--text-subtle)] border border-[var(--border)] rounded px-1.5 py-0.5 shrink-0">
              {user.role === 'admin' ? 'Администратор' : 'Пользователь'}
            </span>
          </button>

          {/* Popover Menu (§5.1) */}
          {profileMenuOpen && (
            <div
              ref={profileMenuRef}
              role="menu"
              aria-label="Меню профиля"
              tabIndex={-1}
              onKeyDown={handleProfileMenuKeyDown}
              className="absolute bottom-full left-3 right-3 mb-2 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-strong)] shadow-panel p-1.5 z-50 text-xs flex flex-col gap-0.5"
            >
              <div className="px-2.5 py-2 border-b border-[var(--border)] mb-1">
                <div className="font-medium text-[var(--text)] truncate">{user.name || user.email?.split('@')[0]}</div>
                <div className="text-[11px] text-[var(--text-muted)] truncate">{user.email}</div>
                <div className="mt-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-subtle)] border border-[var(--border)]">
                    {user.role === 'admin' ? 'Администратор' : 'Пользователь'}
                  </span>
                </div>
              </div>

              <Link
                href="/settings"
                role="menuitem"
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                onClick={() => setProfileMenuOpen(false)}
              >
                <Settings size={14} className="text-[var(--text-muted)]" />
                <span>Настройки</span>
              </Link>

              {user.role === 'admin' && (
                <Link
                  href="/admin"
                  role="menuitem"
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                  onClick={() => setProfileMenuOpen(false)}
                >
                  <Shield size={14} className="text-[var(--accent)]" />
                  <span>Админ-панель</span>
                </Link>
              )}

              <div className="border-t border-[var(--border)] my-1" />

              <button
                type="button"
                role="menuitem"
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--danger)] hover:bg-[var(--danger-quiet)] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                onClick={handleSignOut}
              >
                <LogOut size={14} />
                <span>{ru.signOut}</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Header 56px (§2: No «← На главную», mobile menu on right with «Новый чат») */}
        <header className="h-14 min-h-[56px] border-b border-[var(--border)] bg-[var(--bg)] px-3 sm:px-4 flex items-center justify-between gap-2 z-20">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 mr-2">
            <IconButton
              type="button"
              aria-label={sidebarCollapsed ? 'Показать панель' : 'Скрыть панель'}
              tooltip={sidebarCollapsed ? 'Показать панель' : 'Скрыть панель'}
              icon={<PanelLeft size={18} />}
              variant="ghost"
              size="md"
              className="text-[var(--text-muted)] shrink-0"
              onClick={() => {
                if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches) {
                  setSidebarCollapsed(prev => {
                    const next = !prev;
                    try { window.localStorage.setItem('neyra:sidebar-collapsed', next ? '1' : '0'); } catch {}
                    return next;
                  });
                } else {
                  setSidebarOpen(true);
                }
              }}
            />
            <h1
              className="text-[15px] font-medium text-[var(--text)] truncate min-w-0 max-w-[260px] sm:max-w-[400px] md:max-w-xl"
              title={threadTitle}
            >
              {threadTitle}
            </h1>
          </div>

        </header>

        {/* Messages Feed (max 720px column) (§3) */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto px-4 md:px-6 py-6"
          aria-label="Сообщения чата"
        >
          <div className="content-column space-y-6">
            {/* Empty State */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center text-center pt-16 md:pt-24 pb-8 select-none">
                <NeyraLogo size={40} />
                <h2 className="text-[26px] md:text-[30px] font-semibold tracking-tight text-[var(--text)] mt-4 mb-2">
                  {ru.emptyChat}
                </h2>
                <p className="text-[14px] text-[var(--text-muted)] max-w-[380px]">
                  Задайте вопрос — или начните с готового сценария под полем ввода.
                </p>
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
                    <div className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] px-3.5 py-2.5 text-[15px] leading-[24px] text-[var(--text)] whitespace-pre-wrap">
                      {msg.content}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap gap-1.5">
                          {msg.attachments.map(att => (
                            <span
                              key={att.id}
                              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--surface-3)] text-xs text-[var(--text-muted)]"
                            >
                              {att.isImage ? <ImageIcon size={12} /> : <FileText size={12} />}
                              <span>{att.name}</span>
                              <span className="text-[10px] text-[var(--text-subtle)]">({formatFileSize(att.size)})</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : msg.error ? (
                  // Failed Exchange Error Block: humanized message + icon buttons with tooltips
                  (() => {
                    const parsed = humanizeErrorMessage(msg.error);
                    return (
                      <div
                        role="alert"
                        className="w-full rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3.5 text-xs text-[var(--danger)] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="flex flex-col gap-1 min-w-0">
                          <span className="font-medium text-[var(--danger)] leading-relaxed">{parsed.message}</span>
                          {parsed.hint && (
                            <span className="text-[11px] text-[var(--text-muted)] font-normal">{parsed.hint}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                          <IconButton
                            type="button"
                            aria-label="Повторить"
                            tooltip={msg.isRetrying ? 'Повторяю…' : 'Повторить'}
                            icon={
                              <span className="flex items-center">
                                <RefreshCw size={14} className={msg.isRetrying ? 'animate-spin' : ''} />
                                <span className="sr-only">Повторить</span>
                              </span>
                            }
                            variant="secondary"
                            size="sm"
                            disabled={msg.isRetrying || streaming}
                            onClick={() => handleRetry(msg.id)}
                          />
                          <IconButton
                            type="button"
                            aria-label="Удалить"
                            tooltip="Удалить"
                            icon={
                              <span className="flex items-center">
                                <Trash2 size={14} />
                                <span className="sr-only">Удалить</span>
                              </span>
                            }
                            variant="ghost"
                            size="sm"
                            disabled={msg.isRetrying || streaming}
                            onClick={() => handleDeleteExchange(msg.id)}
                            className="text-[var(--danger)] hover:bg-[var(--danger-quiet)]"
                          />
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  // Assistant Message (§3: NO bubble, article typography, full width)
                  <div className="w-full flex flex-col group relative">
                    <div className="text-[12px] font-medium text-[var(--text-subtle)] mb-1 select-none flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        {msg.pending && !msg.content ? (
                          <NeyraLogo size={16} className="avatar-thinking" />
                        ) : null}
                        <span>{ru.assistantRole}</span>
                      </div>
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
                        // V2 Thinking 3-dots indicator with real bounce animation (§4.3, §4.5)
                        <div
                          className="flex items-center gap-2 py-2 text-[var(--text-subtle)] select-none"
                          role="status"
                          aria-label="Нейра думает…"
                        >
                          <span className="sr-only">Нейра думает…</span>
                          <span className="text-[13px] text-[var(--text-muted)] font-medium">Думаю…</span>
                          <div className="flex items-center gap-1">
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] dot-bounce"
                              style={{ animationDelay: '0ms' }}
                            />
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] dot-bounce"
                              style={{ animationDelay: '120ms' }}
                            />
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] dot-bounce"
                              style={{ animationDelay: '240ms' }}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Scroll down floating pill */}
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
          <div className="content-column space-y-2">
            {/* Optional Context Indicator (§5.2) */}
            {usage && (
              <div className="flex justify-end pr-1">
                <ContextIndicator usage={usage} onNewChat={startNewChat} />
              </div>
            )}

            <form onSubmit={handleSubmit} className="flex flex-col">
              {/* Hidden file inputs (§3.2) */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={e => handleFilesSelected(e.target.files, false)}
              />
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={e => handleFilesSelected(e.target.files, true)}
              />

              {/* Attachment error banner */}
              {attachmentError && (
                <div className="mb-1.5 px-3 py-1.5 text-xs text-[var(--danger)] bg-[var(--danger-quiet)] border border-[var(--danger)] rounded-[var(--radius-sm)] flex items-center justify-between">
                  <span>{attachmentError}</span>
                  <button
                    type="button"
                    onClick={() => setAttachmentError(null)}
                    className="text-[var(--danger)] hover:opacity-80"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}

              {/* Быстрые сценарии над полем ввода: только в пустом чате */}
              {messages.length === 0 && (
                <div className="mb-2 flex flex-wrap items-center justify-center gap-2 animate-chips">
                  <Chip onClick={() => sendMessage('Что нового в памяти?')}>Что нового в памяти?</Chip>
                  <Chip onClick={() => sendMessage('Суммируй вчерашний диалог')}>Суммируй вчерашний диалог</Chip>
                  <Chip onClick={() => sendMessage('Проверь состояние сервера')}>Проверь состояние сервера</Chip>
                </div>
              )}

              {/* Composer container */}
              <div className="relative rounded-[var(--radius-lg)] bg-[var(--surface-2)] border border-[var(--border)] p-2.5 shadow-panel focus-within:border-[var(--accent)] transition-colors flex flex-col gap-2">
                {/* File chips row (§3.2) */}
                {attachments.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-[var(--border)]">
                    {attachments.map(att => (
                      <div
                        key={att.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] text-xs text-[var(--text)] group"
                      >
                        {att.isImage ? (
                          <ImageIcon size={13} className="text-[var(--accent)] shrink-0" />
                        ) : (
                          <FileText size={13} className="text-[var(--text-muted)] shrink-0" />
                        )}
                        <span className="truncate max-w-[140px] font-medium">{att.name}</span>
                        <span className="text-[10px] text-[var(--text-subtle)]">
                          {formatFileSize(att.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(att.id)}
                          aria-label={`Удалить ${att.name}`}
                          className="text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors ml-0.5 cursor-pointer"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Input row: Attach button + Textarea + Send button */}
                <div className="flex items-center gap-2">
                  {/* Plus button & Attachment popover (§3.2) */}
                  <div className="relative shrink-0" ref={attachMenuRef}>
                    <IconButton
                      type="button"
                      aria-label="Прикрепить файл"
                      title="Прикрепить файл"
                      icon={<Plus size={16} />}
                      variant="ghost"
                      size="md"
                      rounded
                      disabled={streaming}
                      onClick={() => setAttachMenuOpen(prev => !prev)}
                      className="text-[var(--text-muted)] hover:text-[var(--text)] bg-[var(--surface-3)]"
                    />

                    {attachMenuOpen && (
                      <div
                        role="menu"
                        aria-label="Прикрепить"
                        className="absolute bottom-full left-0 mb-2 w-36 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-strong)] shadow-panel p-1 z-50 text-xs flex flex-col gap-0.5"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left cursor-pointer"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <FileText size={14} className="text-[var(--text-muted)]" />
                          <span>Файл</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left cursor-pointer"
                          onClick={() => imageInputRef.current?.click()}
                        >
                          <ImageIcon size={14} className="text-[var(--accent)]" />
                          <span>Изображение</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Textarea without inner focus ring (§3.1) */}
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={ru.placeholder}
                    disabled={streaming}
                    rows={1}
                    aria-label="Сообщение"
                    className="flex-1 self-center bg-transparent border-0 outline-none resize-none text-[15px] leading-[24px] text-[var(--text)] placeholder-[var(--text-subtle)] placeholder:leading-[24px] max-h-36 min-h-[24px] py-1 focus:outline-none focus:ring-0 focus-visible:outline-none"
                  />

                  {/* Stop or Send button (§3.3) */}
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
                      disabled={!input.trim() && attachments.length === 0}
                      icon={<ArrowUp size={16} />}
                      variant={input.trim() || attachments.length > 0 ? 'primary' : 'ghost'}
                      size="md"
                      rounded
                      className={`shrink-0 transition-colors ${
                        input.trim() || attachments.length > 0
                          ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                          : 'bg-[var(--surface-3)] text-[var(--text-subtle)]'
                      }`}
                    />
                  )}
                </div>
              </div>

              {/* Hint: only visible when chat is empty (§3.4) */}
              {messages.length === 0 && (
                <div className="text-[11px] text-[var(--text-subtle)] text-center mt-1.5 select-none">
                  Enter — отправить, Shift+Enter — новая строка
                </div>
              )}
            </form>
          </div>
        </footer>
      </div>
    </div>
  );
}
