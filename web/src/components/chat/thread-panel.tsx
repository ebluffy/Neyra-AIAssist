'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Info,
  Pin,
  PinOff,
  Paperclip,
  Mic,
  Settings,
  Edit3,
  Trash2,
  ExternalLink,
  Image as ImageIcon,
  FileText,
  Check,
} from 'lucide-react';
import { Button, IconButton } from '../ui';
import { playButtonClickSound } from '../../lib/ui-sounds';

export type ThreadPanelTab = 'about' | 'pinned' | 'attachments' | 'voice' | 'settings';

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

export interface ThreadPanelProps {
  open: boolean;
  onClose: () => void;
  threadId: string;
  threadTitle: string;
  modelName?: string;
  messages: ChatMessageItem[];
  pinnedMessageIds: string[];
  onTogglePinMessage: (messageId: string) => void;
  onJumpToMessage: (messageId: string) => void;
  onRenameThread: (newTitle: string) => void;
  onClearThread: () => void;
  autoScroll: boolean;
  onToggleAutoScroll: (enabled: boolean) => void;
  uiSounds: boolean;
  onToggleUiSounds: (enabled: boolean) => void;
  compactView: boolean;
  onToggleCompactView: (enabled: boolean) => void;
  initialTab?: ThreadPanelTab;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ThreadPanel({
  open,
  onClose,
  threadId,
  threadTitle,
  modelName = 'Neyra AI (основная)',
  messages,
  pinnedMessageIds,
  onTogglePinMessage,
  onJumpToMessage,
  onRenameThread,
  onClearThread,
  autoScroll,
  onToggleAutoScroll,
  uiSounds,
  onToggleUiSounds,
  compactView,
  onToggleCompactView,
  initialTab = 'about',
}: ThreadPanelProps) {
  const [activeTab, setActiveTab] = useState<ThreadPanelTab>(initialTab);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(threadTitle);
  const [confirmClear, setConfirmClear] = useState(false);

  const panelRef = useRef<HTMLElement | null>(null);
  const tabsRef = useRef<Map<ThreadPanelTab, HTMLButtonElement>>(new Map());

  // Sync activeTab when initialTab changes
  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  // Update titleDraft when threadTitle prop changes
  useEffect(() => {
    setTitleDraft(threadTitle);
  }, [threadTitle]);

  // Keyboard navigation for tablist (ArrowLeft, ArrowRight, Home, End)
  const tabList: { id: ThreadPanelTab; label: string; icon: React.ReactNode; badge?: number; ariaLabel?: string }[] = [
    { id: 'about', label: 'О диалоге', icon: <Info size={14} /> },
    {
      id: 'pinned',
      label: 'Закреплённые',
      icon: <Pin size={14} />,
      badge: pinnedMessageIds.length > 0 ? pinnedMessageIds.length : undefined,
    },
    {
      id: 'attachments',
      label: 'Вложения',
      icon: <Paperclip size={14} />,
      badge:
        messages.reduce((acc, m) => acc + (m.attachments?.length || 0), 0) > 0
          ? messages.reduce((acc, m) => acc + (m.attachments?.length || 0), 0)
          : undefined,
    },
    { id: 'voice', label: 'Голос', icon: <Mic size={14} /> },
    { id: 'settings', label: 'Настройки', ariaLabel: 'Настройки треда', icon: <Settings size={14} /> },
  ];

  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let targetIndex = -1;
    if (e.key === 'ArrowRight') {
      targetIndex = (index + 1) % tabList.length;
    } else if (e.key === 'ArrowLeft') {
      targetIndex = (index - 1 + tabList.length) % tabList.length;
    } else if (e.key === 'Home') {
      targetIndex = 0;
    } else if (e.key === 'End') {
      targetIndex = tabList.length - 1;
    }

    if (targetIndex >= 0) {
      e.preventDefault();
      const targetTab = tabList[targetIndex].id;
      setActiveTab(targetTab);
      tabsRef.current.get(targetTab)?.focus();
      playButtonClickSound();
    }
  };

  const handleSaveTitle = (e: React.FormEvent) => {
    e.preventDefault();
    if (titleDraft.trim()) {
      onRenameThread(titleDraft.trim());
      setIsEditingTitle(false);
      playButtonClickSound();
    }
  };

  const pinnedMessages = messages.filter((m) => pinnedMessageIds.includes(m.id));
  const allAttachments = messages.flatMap((m) =>
    (m.attachments || []).map((att) => ({ ...att, messageId: m.id }))
  );

  return (
    <>
      {/* Mobile Backdrop (rendered and transitions when open) */}
      <div
        data-testid="thread-panel-backdrop"
        className={`fixed inset-0 bg-black/50 backdrop-blur-[2px] z-40 lg:hidden transition-opacity duration-200 ease-out ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Main Panel Drawer (Desktop flex-col 320px / Mobile fixed right overlay) */}
      <aside
        ref={panelRef}
        data-testid="thread-panel"
        aria-label="Панель треда"
        className={`fixed lg:static inset-y-0 right-0 z-50 lg:z-auto w-[320px] max-w-[85vw] lg:w-[320px] lg:shrink-0 bg-[var(--surface)] border-l border-[var(--border)] flex flex-col h-full shadow-2xl lg:shadow-none transition-transform duration-200 ease-out select-none ${
          open ? 'translate-x-0' : 'translate-x-full lg:hidden'
        }`}
      >
        {/* Panel Header */}
        <div className="h-14 min-h-[56px] border-b border-[var(--border)] px-4 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[14px] font-semibold tracking-tight text-[var(--text)]">Панель треда</span>
          </div>
          <IconButton
            type="button"
            aria-label="Закрыть панель треда"
            tooltip="Закрыть"
            icon={<X size={16} />}
            variant="ghost"
            size="sm"
            onClick={onClose}
          />
        </div>

        {/* Tab List */}
        <div
          role="tablist"
          aria-label="Вкладки панели треда"
          className="flex flex-wrap items-center border-b border-[var(--border)] bg-[var(--surface-2)]/50 px-2 py-1 gap-1 shrink-0"
        >
          {tabList.map((tab, idx) => {
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  if (el) tabsRef.current.set(tab.id, el);
                  else tabsRef.current.delete(tab.id);
                }}
                id={`thread-panel-tab-${tab.id}`}
                role="tab"
                aria-label={tab.ariaLabel}
                aria-selected={isSelected}
                aria-controls={`thread-panel-panel-${tab.id}`}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => {
                  setActiveTab(tab.id);
                  playButtonClickSound();
                }}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium rounded-[var(--radius-sm)] transition-colors whitespace-nowrap cursor-pointer ${
                  isSelected
                    ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)]/50'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge !== undefined && (
                  <span
                    className={`ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                      isSelected
                        ? 'bg-[var(--surface-3)] text-[var(--text)]'
                        : 'bg-[var(--surface-3)] text-[var(--text-subtle)]'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Content Panel */}
        <div
          id={`thread-panel-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`thread-panel-tab-${activeTab}`}
          tabIndex={0}
          className="flex-1 overflow-y-auto px-4 py-4 space-y-4 focus:outline-none"
        >
          {/* TAB 1: ABOUT */}
          {activeTab === 'about' && (
            <div className="space-y-4">
              {/* Title Section */}
              {isEditingTitle ? (
                <form
                  onSubmit={handleSaveTitle}
                  className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-strong)] p-3 space-y-2.5"
                >
                  <label htmlFor="rename-thread-input" className="text-xs text-[var(--text-subtle)] font-medium block">
                    Название темы
                  </label>
                  <input
                    id="rename-thread-input"
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    className="w-full bg-[var(--surface-3)] border border-[var(--border)] rounded-[var(--radius-sm)] px-2.5 py-1.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
                    autoFocus
                  />
                  <div className="flex items-center justify-end gap-1.5 pt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setTitleDraft(threadTitle);
                        setIsEditingTitle(false);
                      }}
                    >
                      Отмена
                    </Button>
                    <Button type="submit" variant="primary" size="sm">
                      Сохранить
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] p-3 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-[var(--text-subtle)] font-medium mb-1">Название темы</div>
                    <div className="text-sm font-medium text-[var(--text)] break-words">{threadTitle}</div>
                  </div>
                  <IconButton
                    type="button"
                    aria-label="Переименовать диалог"
                    tooltip="Переименовать"
                    icon={<Edit3 size={14} />}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setTitleDraft(threadTitle);
                      setIsEditingTitle(true);
                    }}
                  />
                </div>
              )}

              {/* Stats Card */}
              <div className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] p-3 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">Модель</span>
                  <span className="font-medium text-[var(--text)]">{modelName}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">Всего сообщений</span>
                  <span className="font-medium text-[var(--text)]">{messages.length}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">От пользователя</span>
                  <span className="font-medium text-[var(--text)]">
                    {messages.filter((m) => m.role === 'user').length}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">От ассистента</span>
                  <span className="font-medium text-[var(--text)]">
                    {messages.filter((m) => m.role === 'assistant').length}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">Вложений</span>
                  <span className="font-medium text-[var(--text)]">{allAttachments.length}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">Закреплено</span>
                  <span className="font-medium text-[var(--text)]">{pinnedMessageIds.length}</span>
                </div>
                <div className="flex items-center justify-between text-xs pt-2 border-t border-[var(--border)]">
                  <span className="text-[var(--text-muted)]">ID диалога</span>
                  <span
                    className="font-mono text-[11px] text-[var(--text-subtle)] truncate max-w-[150px]"
                    title={threadId}
                  >
                    {threadId}
                  </span>
                </div>
              </div>

              {/* Clear Conversation Danger Block */}
              <div className="pt-2">
                {confirmClear ? (
                  <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3 space-y-2">
                    <div className="text-xs font-medium text-[var(--danger)]">Очистить всю переписку?</div>
                    <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                      Все сообщения и закрепления в этом диалоге будут удалены безвозвратно.
                    </p>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => {
                          onClearThread();
                          setConfirmClear(false);
                        }}
                      >
                        Да, очистить
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                        Отмена
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full text-[var(--danger)] hover:bg-[var(--danger-quiet)] flex items-center justify-center gap-1.5"
                    onClick={() => setConfirmClear(true)}
                  >
                    <Trash2 size={14} />
                    <span>Очистить диалог</span>
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: PINNED MESSAGES */}
          {activeTab === 'pinned' && (
            <div className="space-y-3">
              {pinnedMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-12 px-3 select-none">
                  <div className="w-10 h-10 rounded-full bg-[var(--surface-2)] flex items-center justify-center mb-3 text-[var(--text-subtle)]">
                    <Pin size={18} />
                  </div>
                  <div className="text-sm font-medium text-[var(--text)] mb-1">Нет закреплённых сообщений</div>
                  <p className="text-xs text-[var(--text-muted)] max-w-[220px] leading-relaxed">
                    Наведите на сообщение в чате и нажмите «Закрепить», чтобы сохранить его здесь.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {pinnedMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className="group/pin rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--border-strong)] p-3 transition-colors flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-[var(--text)]">
                          {msg.role === 'user' ? 'Вы' : 'Neyra'}
                        </span>
                        <div className="flex items-center gap-1">
                          <IconButton
                            type="button"
                            aria-label={`Перейти к сообщению: ${msg.content.slice(0, 24)}`}
                            tooltip="Перейти к сообщению"
                            icon={<ExternalLink size={13} />}
                            variant="ghost"
                            size="sm"
                            onClick={() => onJumpToMessage(msg.id)}
                          />
                          <IconButton
                            type="button"
                            aria-label={`Открепить сообщение: ${msg.content.slice(0, 24)}`}
                            tooltip="Открепить"
                            icon={<PinOff size={13} />}
                            variant="ghost"
                            size="sm"
                            className="text-[var(--text-subtle)] hover:text-[var(--danger)]"
                            onClick={() => onTogglePinMessage(msg.id)}
                          />
                        </div>
                      </div>
                      <p
                        className="text-xs leading-relaxed text-[var(--text-muted)] line-clamp-3 cursor-pointer hover:text-[var(--text)] transition-colors"
                        onClick={() => onJumpToMessage(msg.id)}
                      >
                        {msg.content}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: ATTACHMENTS */}
          {activeTab === 'attachments' && (
            <div className="space-y-3">
              {allAttachments.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-12 px-3 select-none">
                  <div className="w-10 h-10 rounded-full bg-[var(--surface-2)] flex items-center justify-center mb-3 text-[var(--text-subtle)]">
                    <Paperclip size={18} />
                  </div>
                  <div className="text-sm font-medium text-[var(--text)] mb-1">Вложений пока нет</div>
                  <p className="text-xs text-[var(--text-muted)] max-w-[220px] leading-relaxed">
                    Файлы и изображения, отправленные в этот диалог, появятся здесь.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {allAttachments.map((att) => (
                    <div
                      key={att.id}
                      className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] p-2.5 flex items-center justify-between gap-2.5 hover:border-[var(--border-strong)] transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--surface-3)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
                          {att.isImage ? <ImageIcon size={15} /> : <FileText size={15} />}
                        </div>
                        <div className="min-w-0">
                          <div
                            className="text-xs font-medium text-[var(--text)] truncate max-w-[170px]"
                            title={att.name}
                          >
                            {att.name}
                          </div>
                          <div className="text-[10px] text-[var(--text-subtle)]">
                            {formatFileSize(att.size)}
                          </div>
                        </div>
                      </div>
                      <IconButton
                        type="button"
                        aria-label={`Перейти к сообщению с вложением ${att.name}`}
                        tooltip="Перейти к сообщению"
                        icon={<ExternalLink size={13} />}
                        variant="ghost"
                        size="sm"
                        onClick={() => onJumpToMessage(att.messageId)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: VOICE */}
          {activeTab === 'voice' && (
            <div className="space-y-3">
              <div className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-[var(--surface-3)] flex items-center justify-center text-[var(--text)]">
                      <Mic size={16} />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-[var(--text)]">Голосовой режим</div>
                      <div className="text-[11px] text-[var(--text-subtle)]">Двусторонний аудио-чат</div>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)]">
                    Скоро
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                  Скоро: вход в голосовой режим. Голосовое общение с Neyra в реальном времени с низкой задержкой
                  появится в следующем обновлении.
                </p>
                <div className="rounded-[var(--radius-sm)] bg-[var(--surface-3)]/60 border border-[var(--border)] p-2.5 text-[11px] text-[var(--text-subtle)] leading-relaxed">
                  Контракты аудио-событий заложены в платформу и будут активированы после калибровки голосового шлюза ядра.
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: SETTINGS */}
          {activeTab === 'settings' && (
            <div className="space-y-3">
              <div className="rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] p-3 space-y-3.5">
                {/* Auto-scroll */}
                <label className="flex items-start justify-between gap-3 cursor-pointer select-none">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[var(--text)]">Автопрокрутка</div>
                    <div className="text-[11px] text-[var(--text-subtle)] mt-0.5 leading-relaxed">
                      Автоматически прокручивать вниз при появлении новых сообщений
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => onToggleAutoScroll(e.target.checked)}
                    className="mt-0.5 accent-[var(--accent)] h-4 w-4 rounded cursor-pointer"
                  />
                </label>

                <div className="border-t border-[var(--border)]" />

                {/* UI Sounds */}
                <label className="flex items-start justify-between gap-3 cursor-pointer select-none">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[var(--text)]">Звуки интерфейса</div>
                    <div className="text-[11px] text-[var(--text-subtle)] mt-0.5 leading-relaxed">
                      Звуковой отклик кнопок, диалогов и открываемых панелей
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={uiSounds}
                    onChange={(e) => onToggleUiSounds(e.target.checked)}
                    className="mt-0.5 accent-[var(--accent)] h-4 w-4 rounded cursor-pointer"
                  />
                </label>

                <div className="border-t border-[var(--border)]" />

                {/* Compact view */}
                <label className="flex items-start justify-between gap-3 cursor-pointer select-none">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[var(--text)]">Компактный вид</div>
                    <div className="text-[11px] text-[var(--text-subtle)] mt-0.5 leading-relaxed">
                      Уменьшенные вертикальные отступы между сообщениями
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={compactView}
                    onChange={(e) => onToggleCompactView(e.target.checked)}
                    className="mt-0.5 accent-[var(--accent)] h-4 w-4 rounded cursor-pointer"
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
