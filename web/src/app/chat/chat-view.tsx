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
  PanelRight,
  Pin,
  PinOff,
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
import { SettingsDialog } from '../../components/settings-dialog';
import { ChannelsNav } from '../../components/channels/channels-nav';
import { AppSidebar } from '../../components/layout/app-sidebar';
import { ThreadPanel, type ThreadPanelTab } from '../../components/chat/thread-panel';
import {
  playModalOpenSound,
  playModalCloseSound,
  playButtonClickSound,
  isUiSoundsEnabled,
  setUiSoundsEnabled,
} from '../../lib/ui-sounds';
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
  initialThreadPanelOpen?: boolean;
  initialThreadPanelTab?: ThreadPanelTab;
  initialPinnedMessageIds?: string[];
}

export function ChatView({
  user,
  initialMessages,
  initialUsage,
  initialThreadPanelOpen,
  initialThreadPanelTab,
  initialPinnedMessageIds,
}: ChatViewProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessageItem[]>(() => {
    if (initialMessages && initialMessages.length > 0) return initialMessages;
    if (typeof window === 'undefined') return [];
    try {
      const currentTabChatId = resolveChatId(window.sessionStorage, resolveTabKey(window), user.id);
      const raw = window.localStorage.getItem(`neyra:thread-messages:${user.id}:${currentTabChatId}`);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {}
    return [];
  });
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Wave 5 Step 2: Thread Panel states
  const [threadPanelOpen, setThreadPanelOpen] = useState(initialThreadPanelOpen ?? false);
  const panelToggleRef = useRef<HTMLButtonElement | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [uiSoundsEnabled, setUiSoundsEnabledState] = useState(true);
  const [compactViewEnabled, setCompactViewEnabled] = useState(false);
  const [pinnedMessageIds, setPinnedMessageIds] = useState<string[]>(() => {
    if (initialPinnedMessageIds && initialPinnedMessageIds.length > 0) return initialPinnedMessageIds;
    return [];
  });
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [panelInitialTab, setPanelInitialTab] = useState<ThreadPanelTab>(initialThreadPanelTab || 'about');

  // V2 UI states
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatMessageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(() => initialUsage || null);

  useEffect(() => {
    try {
      setSidebarCollapsed(window.localStorage.getItem('neyra:sidebar-collapsed') === '1');
      if (initialThreadPanelOpen === undefined) {
        const savedPanelOpen = window.localStorage.getItem('neyra:thread-panel-open');
        // На телефоне панель — drawer на 320 px и закрывает чат с композером.
        // Сохранённое «открыто» с десктопа не должно открывать её поверх чата.
        const narrow = typeof window.matchMedia === 'function'
          ? window.matchMedia('(max-width: 1023px)').matches
          : false;
        if (savedPanelOpen !== null && !narrow) {
          setThreadPanelOpen(savedPanelOpen === '1');
        }
      }
      const savedAutoScroll = window.localStorage.getItem('neyra:autoscroll');
      if (savedAutoScroll !== null) {
        setAutoScrollEnabled(savedAutoScroll !== '0');
      }
      setUiSoundsEnabledState(isUiSoundsEnabled());
      const savedCompact = window.localStorage.getItem('neyra:compact-view');
      if (savedCompact !== null) {
        setCompactViewEnabled(savedCompact === '1');
      }
    } catch {}
  }, [initialThreadPanelOpen]);

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

  // Load pinned messages whenever chatId or user.id changes
  useEffect(() => {
    if (initialPinnedMessageIds !== undefined) return;
    if (typeof window === 'undefined' || !chatId || !user?.id) {
      setPinnedMessageIds([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(`neyra:pinned-messages:${user.id}:${chatId}`);
      setPinnedMessageIds(raw ? JSON.parse(raw) : []);
    } catch {
      setPinnedMessageIds([]);
    }
  }, [chatId, user?.id, initialPinnedMessageIds]);

  // Leave page cancels active upstream connection
  useEffect(() => () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  // Keyboard navigation & global close on Escape
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc принадлежит верхнему слою: модалка настроек/админки, затем меню.
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
      if (profileMenuOpen) {
        setProfileMenuOpen(false);
        return;
      }
      setSidebarOpen(false);
      setAttachMenuOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [profileMenuOpen]);

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
    if (autoScrollEnabled && !showScrollDown) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, thinking, showScrollDown, autoScrollEnabled]);

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

  // Sync messages & thread list to localStorage per user (§3, AR-12)
  useEffect(() => {
    if (typeof window === 'undefined' || !chatId || !user?.id) return;
    const threadsKey = `neyra:threads:${user.id}`;
    const msgsKey = `neyra:thread-messages:${user.id}:${chatId}`;

    try {
      if (messages.length > 0) {
        // Save thread messages
        window.localStorage.setItem(msgsKey, JSON.stringify(messages));

        // Derive thread title from first user message
        const firstUser = messages.find((m) => m.role === 'user')?.content.trim();
        const derivedTitle = customTitle || (firstUser ? firstUser.split('\n')[0].slice(0, 80) : 'Диалог');

        const rawThreads = window.localStorage.getItem(threadsKey);
        let list: { id: string; title: string; updatedAt: string }[] = rawThreads ? JSON.parse(rawThreads) : [];
        const existingIdx = list.findIndex((t) => t.id === chatId);
        if (existingIdx >= 0) {
          list[existingIdx] = {
            ...list[existingIdx],
            title: derivedTitle,
            updatedAt: new Date().toISOString(),
          };
        } else {
          list = [
            {
              id: chatId,
              title: derivedTitle,
              updatedAt: new Date().toISOString(),
            },
            ...list,
          ];
        }
        window.localStorage.setItem(threadsKey, JSON.stringify(list));
      } else {
        // When messages are empty (new chat or deleted exchange)
        window.localStorage.removeItem(msgsKey);
        const rawThreads = window.localStorage.getItem(threadsKey);
        if (rawThreads) {
          const list: { id: string; title: string }[] = JSON.parse(rawThreads);
          const filtered = list.filter((t) => t.id !== chatId);
          window.localStorage.setItem(threadsKey, JSON.stringify(filtered));
        }
      }
    } catch {}
  }, [messages, chatId, user?.id, customTitle]);

  const switchThread = (targetThreadId: string) => {
    if (streaming) {
      stopGeneration();
    }
    setChatId(targetThreadId);
    try {
      sessionStorage.setItem(`neyra.chat_id:${user.id}:${resolveTabKey(window)}`, targetThreadId);
      const raw = window.localStorage.getItem(`neyra:thread-messages:${user.id}:${targetThreadId}`);
      if (raw) {
        setMessages(JSON.parse(raw));
      } else {
        setMessages([]);
      }
      const rawPins = window.localStorage.getItem(`neyra:pinned-messages:${user.id}:${targetThreadId}`);
      setPinnedMessageIds(rawPins ? JSON.parse(rawPins) : []);
      const rawThreads = window.localStorage.getItem(`neyra:threads:${user.id}`);
      if (rawThreads) {
        const list = JSON.parse(rawThreads);
        const targetThread = list.find((t: any) => t.id === targetThreadId);
        setCustomTitle(targetThread ? targetThread.title : null);
      }
    } catch {
      setMessages([]);
      setPinnedMessageIds([]);
    }
    setSidebarOpen(false);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const deleteThread = (targetThreadId: string) => {
    try {
      window.localStorage.removeItem(`neyra:thread-messages:${user.id}:${targetThreadId}`);
      window.localStorage.removeItem(`neyra:pinned-messages:${user.id}:${targetThreadId}`);
      const raw = window.localStorage.getItem(`neyra:threads:${user.id}`);
      if (raw) {
        const list = JSON.parse(raw);
        const filtered = list.filter((t: { id: string }) => t.id !== targetThreadId);
        window.localStorage.setItem(`neyra:threads:${user.id}`, JSON.stringify(filtered));
      }
    } catch {}
    if (chatId === targetThreadId) {
      startNewChat();
    }
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
    setPinnedMessageIds([]);
    setCustomTitle(null);
    setThinking(false);
    setStreaming(false);
    setSidebarOpen(false);
    setAttachments([]);
    setAttachmentError(null);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleToggleThreadPanel = () => {
    setThreadPanelOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('neyra:thread-panel-open', next ? '1' : '0');
      } catch {}
      if (next) {
        playModalOpenSound();
      } else {
        playModalCloseSound();
      }
      return next;
    });
  };

  const handleCloseThreadPanel = () => {
    setThreadPanelOpen(false);
    try {
      window.localStorage.setItem('neyra:thread-panel-open', '0');
    } catch {}
    playModalCloseSound();
    panelToggleRef.current?.focus();
  };

  const handleTogglePinMessage = (msgId: string) => {
    setPinnedMessageIds((prev) => {
      const isPinned = prev.includes(msgId);
      const next = isPinned ? prev.filter((id) => id !== msgId) : [...prev, msgId];
      try {
        window.localStorage.setItem(`neyra:pinned-messages:${user.id}:${chatId}`, JSON.stringify(next));
      } catch {}
      playButtonClickSound();
      return next;
    });
  };

  const handleJumpToMessage = (msgId: string) => {
    const el = document.getElementById(`message-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedMessageId(msgId);
      setTimeout(() => {
        setHighlightedMessageId(null);
      }, 1500);
    }
  };

  const handleRenameThread = (newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setCustomTitle(trimmed);
    try {
      const threadsKey = `neyra:threads:${user.id}`;
      const rawThreads = window.localStorage.getItem(threadsKey);
      if (rawThreads) {
        let list: { id: string; title: string; updatedAt: string }[] = JSON.parse(rawThreads);
        const idx = list.findIndex((t) => t.id === chatId);
        if (idx >= 0) {
          list[idx] = { ...list[idx], title: trimmed, updatedAt: new Date().toISOString() };
          window.localStorage.setItem(threadsKey, JSON.stringify(list));
        }
      }
    } catch {}
  };

  const handleClearThread = () => {
    setMessages([]);
    setPinnedMessageIds([]);
    try {
      window.localStorage.removeItem(`neyra:thread-messages:${user.id}:${chatId}`);
      window.localStorage.removeItem(`neyra:pinned-messages:${user.id}:${chatId}`);
      const threadsKey = `neyra:threads:${user.id}`;
      const rawThreads = window.localStorage.getItem(threadsKey);
      if (rawThreads) {
        const list = JSON.parse(rawThreads);
        const filtered = list.filter((t: any) => t.id !== chatId);
        window.localStorage.setItem(threadsKey, JSON.stringify(filtered));
      }
    } catch {}
    playButtonClickSound();
  };

  const handleToggleAutoScroll = (enabled: boolean) => {
    setAutoScrollEnabled(enabled);
    try {
      window.localStorage.setItem('neyra:autoscroll', enabled ? '1' : '0');
    } catch {}
  };

  const handleToggleUiSounds = (enabled: boolean) => {
    setUiSoundsEnabledState(enabled);
    setUiSoundsEnabled(enabled);
  };

  const handleToggleCompactView = (enabled: boolean) => {
    setCompactViewEnabled(enabled);
    try {
      window.localStorage.setItem('neyra:compact-view', enabled ? '1' : '0');
    } catch {}
  };

  // Close thread panel on Escape key and return focus to toggle button
  useEffect(() => {
    if (!threadPanelOpen) return;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Верхний слой (настройки/админка) закрывает сам себя; панель не трогаем.
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
      if (profileMenuOpen) return;
      e.stopPropagation();
      handleCloseThreadPanel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [threadPanelOpen, profileMenuOpen]);

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
    <div data-chat-shell className="relative flex h-[100svh] min-h-0 w-full bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      <AmbientBackground />
      <AppSidebar
        activeSection="chat"
        user={user}
        threadTitle={threadTitle}
        activeThreadId={chatId}
        onNewChat={startNewChat}
        onSelectThread={switchThread}
        onDeleteThread={deleteThread}
        mobileOpen={sidebarOpen}
        onCloseMobile={() => setSidebarOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main Column */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Header 56px (§2: No «← На главную», mobile menu on right with «Новый чат») */}
        <header className="h-14 min-h-[56px] border-b border-[var(--border)] bg-[var(--bg)] px-3 sm:px-4 flex items-center justify-between gap-2 z-20 pt-[env(safe-area-inset-top)]">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 mr-2">
            <IconButton
              type="button"
              aria-label="Открыть панель"
              tooltip="Открыть панель"
              icon={<PanelLeft size={18} />}
              variant="ghost"
              size="md"
              className="lg:hidden text-[var(--text-muted)] shrink-0"
              onClick={() => setSidebarOpen(true)}
            />
            <h1
              className="text-[15px] font-medium text-[var(--text)] truncate min-w-0 max-w-[260px] sm:max-w-[400px] md:max-w-xl"
              title={threadTitle}
            >
              {threadTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] text-xs text-[var(--text-muted)] border border-[var(--border)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
              <span>Neyra AI</span>
            </span>
            <IconButton
              ref={panelToggleRef}
              type="button"
              aria-label="Панель треда"
              tooltip="Панель треда"
              aria-expanded={threadPanelOpen}
              icon={<PanelRight size={18} />}
              variant={threadPanelOpen ? 'secondary' : 'ghost'}
              size="md"
              className={`shrink-0 ${threadPanelOpen ? 'text-[var(--text)] bg-[var(--surface-3)]' : 'text-[var(--text-muted)]'}`}
              onClick={handleToggleThreadPanel}
            />
          </div>
        </header>

        {/* Content Area with Split Layout for Right Thread Panel */}
        <div className="flex-1 flex flex-row min-h-0 overflow-hidden relative">
          {/* Main Feed Column */}
          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative">

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
                id={`message-${msg.id}`}
                className={`flex flex-col w-full ${msg.role === 'user' ? 'items-end' : 'items-start'} ${
                  highlightedMessageId === msg.id
                    ? 'ring-2 ring-[var(--accent)] bg-[var(--surface-2)]/70 rounded-[var(--radius)] p-2.5 transition-all duration-300'
                    : 'transition-all duration-300'
                }`}
              >
                {msg.role === 'user' ? (
                  // User Message (§3: surface-2 bubble, right, max 78%)
                  <div className="flex flex-col items-end max-w-[78%] group/usermsg">
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
                    <div className="flex items-center gap-1 mt-1 opacity-0 group-hover/usermsg:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => handleTogglePinMessage(msg.id)}
                        aria-label={pinnedMessageIds.includes(msg.id) ? 'Открепить сообщение' : 'Закрепить сообщение'}
                        title={pinnedMessageIds.includes(msg.id) ? 'Открепить' : 'Закрепить'}
                        className={`flex items-center gap-1 text-[11px] p-1 rounded hover:bg-[var(--surface-3)] cursor-pointer ${
                          pinnedMessageIds.includes(msg.id)
                            ? 'text-[var(--text)] font-medium opacity-100'
                            : 'text-[var(--text-subtle)] hover:text-[var(--text)]'
                        }`}
                      >
                        {pinnedMessageIds.includes(msg.id) ? <PinOff size={12} /> : <Pin size={12} />}
                        <span>{pinnedMessageIds.includes(msg.id) ? 'Открепить' : 'Закрепить'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopyMessage(msg.id, msg.content)}
                        aria-label={copiedMessageId === msg.id ? 'Скопировано' : 'Скопировать сообщение'}
                        className="text-[var(--text-subtle)] hover:text-[var(--text)] flex items-center gap-1 text-[11px] p-1 rounded hover:bg-[var(--surface-3)] cursor-pointer"
                      >
                        {copiedMessageId === msg.id ? (
                          <Check size={12} className="text-[var(--success)]" />
                        ) : (
                          <Copy size={12} />
                        )}
                        <span>{copiedMessageId === msg.id ? 'Скопировано' : 'Копировать'}</span>
                      </button>
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
                      <div className="flex items-center gap-1.5">
                        {msg.content && (
                          <button
                            type="button"
                            onClick={() => handleTogglePinMessage(msg.id)}
                            aria-label={pinnedMessageIds.includes(msg.id) ? 'Открепить сообщение' : 'Закрепить сообщение'}
                            title={pinnedMessageIds.includes(msg.id) ? 'Открепить' : 'Закрепить'}
                            className={`opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center gap-1 text-[11px] p-1 rounded hover:bg-[var(--surface-3)] cursor-pointer ${
                              pinnedMessageIds.includes(msg.id)
                                ? 'opacity-100 text-[var(--text)] font-medium'
                                : 'text-[var(--text-subtle)] hover:text-[var(--text)]'
                            }`}
                          >
                            {pinnedMessageIds.includes(msg.id) ? <PinOff size={12} /> : <Pin size={12} />}
                            <span>{pinnedMessageIds.includes(msg.id) ? 'Открепить' : 'Закрепить'}</span>
                          </button>
                        )}
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
        <footer className="sticky bottom-0 z-20 bg-[var(--bg)]/90 backdrop-blur-md pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] px-4 border-t border-transparent">
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

      {/* Right Thread Panel (320px column on desktop / overlay on mobile) */}
      <ThreadPanel
        open={threadPanelOpen}
        onClose={handleCloseThreadPanel}
        threadId={chatId}
        threadTitle={threadTitle}
        messages={messages}
        pinnedMessageIds={pinnedMessageIds}
        onTogglePinMessage={handleTogglePinMessage}
        onJumpToMessage={handleJumpToMessage}
        onRenameThread={handleRenameThread}
        onClearThread={handleClearThread}
        autoScroll={autoScrollEnabled}
        onToggleAutoScroll={handleToggleAutoScroll}
        uiSounds={uiSoundsEnabled}
        onToggleUiSounds={handleToggleUiSounds}
        compactView={compactViewEnabled}
        onToggleCompactView={handleToggleCompactView}
        initialTab={panelInitialTab}
      />
    </div>
  </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        user={user}
        onSignOut={handleSignOut}
      />
    </div>
  );
}
