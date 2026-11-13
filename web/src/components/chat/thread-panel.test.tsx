// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThreadPanel, ChatMessageItem } from './thread-panel';

describe('ThreadPanel', () => {
  const sampleMessages: ChatMessageItem[] = [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Привет! Помоги настроить Docker контейнер.',
      attachments: [
        { id: 'att-1', name: 'docker-compose.yml', size: 1024, isImage: false },
        { id: 'att-2', name: 'diagram.png', size: 204800, isImage: true },
      ],
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: 'Конечно! Вот базовый конфигурационный файл docker-compose для вашей задачи.',
    },
    {
      id: 'msg-3',
      role: 'user',
      content: 'А как добавить volume для сохранения данных?',
    },
    {
      id: 'msg-4',
      role: 'assistant',
      content: 'Используйте директиву volumes в сервисе.',
    },
  ];

  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    threadId: 'th-test-123',
    threadTitle: 'Настройка Docker контейнера',
    modelName: 'Neyra AI (основная)',
    messages: sampleMessages,
    pinnedMessageIds: ['msg-2'],
    onTogglePinMessage: vi.fn(),
    onJumpToMessage: vi.fn(),
    onRenameThread: vi.fn(),
    onClearThread: vi.fn(),
    autoScroll: true,
    onToggleAutoScroll: vi.fn(),
    uiSounds: true,
    onToggleUiSounds: vi.fn(),
    compactView: false,
    onToggleCompactView: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders open panel with header, tablist and "О диалоге" tab by default', () => {
    render(<ThreadPanel {...defaultProps} />);

    expect(screen.getByTestId('thread-panel')).toBeDefined();
    expect(screen.getByText('Панель треда')).toBeDefined();
    expect(screen.getByRole('tablist', { name: 'Вкладки панели треда' })).toBeDefined();

    // Tab buttons
    expect(screen.getByRole('tab', { name: /О диалоге/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Закреплённые/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Вложения/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Голос/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Настройки треда/ })).toBeDefined();

    // Default "about" tab content
    expect(screen.getByText('Настройка Docker контейнера')).toBeDefined();
    expect(screen.getByText('Neyra AI (основная)')).toBeDefined();
    expect(screen.getByText('th-test-123')).toBeDefined();
    expect(screen.getByText('Всего сообщений')).toBeDefined();
  });

  it('calls onClose when close button or mobile backdrop is clicked', () => {
    render(<ThreadPanel {...defaultProps} />);

    const closeBtn = screen.getByRole('button', { name: 'Закрыть панель треда' });
    fireEvent.click(closeBtn);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);

    const backdrop = screen.getByTestId('thread-panel-backdrop');
    fireEvent.click(backdrop);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(2);
  });

  it('navigates tabs using keyboard ArrowLeft / ArrowRight / Home / End', () => {
    render(<ThreadPanel {...defaultProps} />);

    const aboutTab = screen.getByRole('tab', { name: /О диалоге/ });
    const pinnedTab = screen.getByRole('tab', { name: /Закреплённые/ });
    const attachmentsTab = screen.getByRole('tab', { name: /Вложения/ });
    const voiceTab = screen.getByRole('tab', { name: /Голос/ });
    const settingsTab = screen.getByRole('tab', { name: /Настройки треда/ });

    // ArrowRight from About -> Pinned
    fireEvent.keyDown(aboutTab, { key: 'ArrowRight' });
    expect(pinnedTab.getAttribute('aria-selected')).toBe('true');

    // ArrowRight from Pinned -> Attachments
    fireEvent.keyDown(pinnedTab, { key: 'ArrowRight' });
    expect(attachmentsTab.getAttribute('aria-selected')).toBe('true');

    // End -> Settings
    fireEvent.keyDown(attachmentsTab, { key: 'End' });
    expect(settingsTab.getAttribute('aria-selected')).toBe('true');

    // Home -> About
    fireEvent.keyDown(settingsTab, { key: 'Home' });
    expect(aboutTab.getAttribute('aria-selected')).toBe('true');

    // ArrowLeft from About -> wraps to Settings
    fireEvent.keyDown(aboutTab, { key: 'ArrowLeft' });
    expect(settingsTab.getAttribute('aria-selected')).toBe('true');
  });

  it('supports renaming thread title and saving', () => {
    render(<ThreadPanel {...defaultProps} />);

    const renameBtn = screen.getByRole('button', { name: 'Переименовать диалог' });
    fireEvent.click(renameBtn);

    const input = screen.getByLabelText('Название темы');
    expect(input).toBeDefined();
    fireEvent.change(input, { target: { value: 'Новое название темы' } });

    const saveBtn = screen.getByRole('button', { name: 'Сохранить' });
    fireEvent.click(saveBtn);

    expect(defaultProps.onRenameThread).toHaveBeenCalledWith('Новое название темы');
  });

  it('handles "Очистить диалог" with confirmation flow', () => {
    render(<ThreadPanel {...defaultProps} />);

    const clearBtn = screen.getByRole('button', { name: 'Очистить диалог' });
    fireEvent.click(clearBtn);

    expect(screen.getByText('Очистить всю переписку?')).toBeDefined();

    // Cancel first
    const cancelBtn = screen.getByRole('button', { name: 'Отмена' });
    fireEvent.click(cancelBtn);
    expect(defaultProps.onClearThread).not.toHaveBeenCalled();

    // Click again and confirm
    const clearBtnAgain = screen.getByRole('button', { name: 'Очистить диалог' });
    fireEvent.click(clearBtnAgain);

    const confirmBtn = screen.getByRole('button', { name: 'Да, очистить' });
    fireEvent.click(confirmBtn);

    expect(defaultProps.onClearThread).toHaveBeenCalledTimes(1);
  });

  it('renders pinned messages tab, unpins and jumps to message', () => {
    render(<ThreadPanel {...defaultProps} initialTab="pinned" />);

    expect(screen.getByText('Конечно! Вот базовый конфигурационный файл docker-compose для вашей задачи.')).toBeDefined();

    // Jump to message
    const jumpBtn = screen.getByRole('button', { name: /Перейти к сообщению/ });
    fireEvent.click(jumpBtn);
    expect(defaultProps.onJumpToMessage).toHaveBeenCalledWith('msg-2');

    // Unpin message
    const unpinBtn = screen.getByRole('button', { name: /Открепить сообщение/ });
    fireEvent.click(unpinBtn);
    expect(defaultProps.onTogglePinMessage).toHaveBeenCalledWith('msg-2');
  });

  it('renders empty pinned state when no messages are pinned', () => {
    render(<ThreadPanel {...defaultProps} pinnedMessageIds={[]} initialTab="pinned" />);

    expect(screen.getByText('Нет закреплённых сообщений')).toBeDefined();
    expect(screen.getByText(/Наведите на сообщение в чате и нажмите «Закрепить»/)).toBeDefined();
  });

  it('renders attachments tab with file list and jump buttons without fake upload', () => {
    render(<ThreadPanel {...defaultProps} initialTab="attachments" />);

    expect(screen.getByText('docker-compose.yml')).toBeDefined();
    expect(screen.getByText('diagram.png')).toBeDefined();
    expect(screen.getByText('1.0 KB')).toBeDefined();
    expect(screen.getByText('200.0 KB')).toBeDefined();

    const jumpBtns = screen.getAllByRole('button', { name: /Перейти к сообщению с вложением/ });
    expect(jumpBtns.length).toBe(2);
    fireEvent.click(jumpBtns[0]);
    expect(defaultProps.onJumpToMessage).toHaveBeenCalledWith('msg-1');
  });

  it('renders empty attachments state when no attachments exist', () => {
    const noAttMessages = sampleMessages.map(m => ({ ...m, attachments: [] }));
    render(<ThreadPanel {...defaultProps} messages={noAttMessages} initialTab="attachments" />);

    expect(screen.getByText('Вложений пока нет')).toBeDefined();
  });

  it('renders voice tab with honest "Скоро" status card and no false connect buttons', () => {
    render(<ThreadPanel {...defaultProps} initialTab="voice" />);

    expect(screen.getByText('Голосовой режим')).toBeDefined();
    expect(screen.getByText('Скоро')).toBeDefined();
    expect(screen.getByText(/Скоро: вход в голосовой режим/)).toBeDefined();

    // Ensure no fake start/connect buttons are displayed
    expect(screen.queryByRole('button', { name: /Начать запись/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Подключить микрофон/ })).toBeNull();
  });

  it('renders thread settings tab and handles toggles', () => {
    render(<ThreadPanel {...defaultProps} initialTab="settings" />);

    expect(screen.getByText('Автопрокрутка')).toBeDefined();
    expect(screen.getByText('Звуки интерфейса')).toBeDefined();
    expect(screen.getByText('Компактный вид')).toBeDefined();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(3);

    // Toggle autoscroll
    fireEvent.click(checkboxes[0]);
    expect(defaultProps.onToggleAutoScroll).toHaveBeenCalledWith(false);

    // Toggle ui sounds
    fireEvent.click(checkboxes[1]);
    expect(defaultProps.onToggleUiSounds).toHaveBeenCalledWith(false);

    // Toggle compact view
    fireEvent.click(checkboxes[2]);
    expect(defaultProps.onToggleCompactView).toHaveBeenCalledWith(true);
  });

  it('ensures model_trace is never leaked or exposed', () => {
    const rawHtml = render(<ThreadPanel {...defaultProps} />).container.innerHTML;
    expect(rawHtml).not.toContain('model_trace');
  });
});
