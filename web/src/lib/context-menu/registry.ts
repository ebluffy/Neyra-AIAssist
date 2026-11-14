'use client';

import type { Flag } from '../feature-flags';
import { soonToast, emitToast } from '../toast';

export interface MenuTarget {
  kind: string;
  id?: string;
  title?: string;
  url?: string;
  role?: 'user' | 'assistant';
  selectedCount?: number;
  text?: string;
  element?: HTMLElement | null;
  data?: Record<string, unknown>;
}

export interface MenuItem {
  id: string;
  label: string;
  iconName?: string;
  shortcut?: string;
  danger?: boolean;
  separator?: boolean;
  flag?: Flag;
  disabled?: boolean;
  run?: (target: MenuTarget) => void;
}

export function getMenu(kind: string, target: MenuTarget): MenuItem[] {
  switch (kind) {
    case 'chat-item': {
      const isMulti = (target.selectedCount || 0) > 1;
      return [
        {
          id: 'chat-open',
          label: 'Открыть',
          iconName: 'MessageSquare',
          run: () => {
            if (target.id) window.location.href = `/chat?th=${target.id}`;
          },
        },
        {
          id: 'chat-rename',
          label: 'Переименовать',
          iconName: 'Edit2',
          shortcut: 'F2',
          run: () => soonToast('Переименование чата', 'Инлайн-редактор заголовка'),
        },
        {
          id: 'chat-pin',
          label: 'Закрепить вверху',
          iconName: 'Pin',
          run: () => soonToast('Закрепление чатов'),
        },
        {
          id: 'chat-move-folder',
          label: 'Переместить в папку…',
          iconName: 'FolderPlus',
          run: () => soonToast('Папки чатов', 'Организация диалогов по категориям'),
        },
        {
          id: 'chat-duplicate',
          label: 'Создать копию',
          iconName: 'Copy',
          run: () => soonToast('Копирование чата'),
        },
        {
          id: 'chat-copy-link',
          label: 'Скопировать ссылку',
          iconName: 'Share2',
          run: () => {
            navigator.clipboard.writeText(`${window.location.origin}/chat?th=${target.id || ''}`);
            emitToast({ message: 'Ссылка на чат скопирована в буфер', tone: 'success' });
          },
        },
        {
          id: 'chat-export',
          label: 'Экспорт (MD / JSON)',
          iconName: 'Download',
          flag: 'exportData',
          run: () => soonToast('Экспорт чата'),
        },
        { separator: true, id: 'sep-1', label: '' },
        {
          id: 'chat-archive',
          label: 'Перенести в архив',
          iconName: 'Archive',
          run: () => soonToast('Архив чатов'),
        },
        {
          id: 'chat-delete',
          label: isMulti ? `Удалить ${target.selectedCount} чатов` : 'Удалить чат',
          iconName: 'Trash2',
          danger: true,
          shortcut: 'Delete',
          run: () => {
            if (target.element) {
              const delBtn = target.element.querySelector('button[aria-label*="Удалить"]') as HTMLButtonElement | null;
              if (delBtn) {
                delBtn.click();
                return;
              }
            }
            emitToast({ message: `Чат «${target.title || 'Беседа'}» удалён`, tone: 'info' });
          },
        },
      ];
    }

    case 'note-item': {
      return [
        {
          id: 'note-open',
          label: 'Открыть заметку',
          iconName: 'FileText',
          run: () => {
            if (target.element) {
              const btn = target.element.querySelector('button') as HTMLButtonElement | null;
              btn?.click();
            }
          },
        },
        {
          id: 'note-edit',
          label: 'Редактировать',
          iconName: 'Edit2',
          shortcut: 'Enter',
          run: () => {
            if (target.element) {
              const editBtn = target.element.querySelector('button[aria-label*="Редактировать"]') as HTMLButtonElement | null;
              editBtn?.click();
            }
          },
        },
        {
          id: 'note-pin',
          label: 'Закрепить заметку',
          iconName: 'Pin',
          run: () => soonToast('Закрепление заметок'),
        },
        {
          id: 'note-copy',
          label: 'Копировать текст',
          iconName: 'Copy',
          shortcut: '⌘C',
          run: () => {
            if (target.text || target.title) {
              navigator.clipboard.writeText(`${target.title || ''}\n${target.text || ''}`);
              emitToast({ message: 'Текст заметки скопирован', tone: 'success' });
            }
          },
        },
        {
          id: 'note-tags',
          label: 'Теги и категории…',
          iconName: 'Tag',
          run: () => soonToast('Теги заметок'),
        },
        {
          id: 'note-export',
          label: 'Экспорт в Markdown',
          iconName: 'Download',
          flag: 'exportData',
          run: () => soonToast('Экспорт заметки'),
        },
        { separator: true, id: 'sep-note', label: '' },
        {
          id: 'note-delete',
          label: 'Удалить заметку',
          iconName: 'Trash2',
          danger: true,
          shortcut: 'Delete',
          run: () => {
            if (target.element) {
              const delBtn = target.element.querySelector('button[aria-label*="Удалить"]') as HTMLButtonElement | null;
              delBtn?.click();
            }
          },
        },
      ];
    }

    case 'chat-group': {
      return [
        {
          id: 'group-toggle',
          label: 'Свернуть / Развернуть',
          iconName: 'ChevronDown',
          run: () => soonToast('Группы чатов'),
        },
        {
          id: 'group-rename',
          label: 'Переименовать группу',
          iconName: 'Edit2',
          run: () => soonToast('Переименование группы'),
        },
        { separator: true, id: 'sep-group', label: '' },
        {
          id: 'group-delete',
          label: 'Удалить папку',
          iconName: 'Trash2',
          danger: true,
          run: () => soonToast('Удаление папки'),
        },
      ];
    }

    case 'chat-message': {
      const isAssistant = target.role === 'assistant';
      return [
        {
          id: 'msg-copy',
          label: 'Копировать текст',
          iconName: 'Copy',
          shortcut: '⌘C',
          run: () => {
            if (target.text) {
              navigator.clipboard.writeText(target.text);
              emitToast({ message: 'Сообщение скопировано в буфер', tone: 'success' });
            }
          },
        },
        {
          id: 'msg-copy-md',
          label: 'Копировать как Markdown',
          iconName: 'FileCode',
          run: () => {
            if (target.text) {
              navigator.clipboard.writeText(target.text);
              emitToast({ message: 'Markdown скопирован', tone: 'success' });
            }
          },
        },
        {
          id: 'msg-quote',
          label: 'Ответить с цитатой',
          iconName: 'Quote',
          run: () => soonToast('Цитирование сообщений'),
        },
        {
          id: 'msg-thread',
          label: 'Создать ветку ответа',
          iconName: 'GitBranch',
          run: () => soonToast('Ветвление контекста'),
        },
        ...(isAssistant
          ? [
              {
                id: 'msg-retry',
                label: 'Повторить генерацию',
                iconName: 'RotateCw',
                shortcut: '⌘R',
                run: () => soonToast('Повтор генерации ответа'),
              },
              {
                id: 'msg-tts',
                label: 'Озвучить сообщение',
                iconName: 'Volume2',
                flag: 'chatVoice' as Flag,
                run: () => soonToast('Озвучивание текста (TTS)'),
              },
              {
                id: 'msg-rate',
                label: 'Оценить ответ',
                iconName: 'ThumbsUp',
                run: () => soonToast('Оценка качества ответа'),
              },
              {
                id: 'msg-sources',
                label: 'Показать источники и цитаты',
                iconName: 'ExternalLink',
                run: () => soonToast('Источники ответа модели'),
              },
            ]
          : [
              {
                id: 'msg-edit',
                label: 'Изменить сообщение',
                iconName: 'Edit2',
                run: () => soonToast('Редактирование своего сообщения'),
              },
            ]),
        { separator: true, id: 'sep-msg', label: '' },
        {
          id: 'msg-select',
          label: 'Выбрать несколько сообщений',
          iconName: 'CheckSquare',
          run: () => soonToast('Мультивыбор сообщений'),
        },
        {
          id: 'msg-delete',
          label: 'Удалить сообщение',
          iconName: 'Trash2',
          danger: true,
          run: () => emitToast({ message: 'Сообщение скрыто', tone: 'info' }),
        },
      ];
    }

    case 'composer': {
      return [
        {
          id: 'composer-paste',
          label: 'Вставить',
          iconName: 'Clipboard',
          shortcut: '⌘V',
          run: () => soonToast('Вставка из буфера', 'Используйте сочетание ⌘V / Ctrl+V'),
        },
        {
          id: 'composer-paste-plain',
          label: 'Вставить без форматирования',
          iconName: 'FileText',
          shortcut: '⇧⌘V',
          run: () => soonToast('Вставка без стилей'),
        },
        {
          id: 'composer-attach',
          label: 'Прикрепить файл…',
          iconName: 'Paperclip',
          flag: 'chatAttachments',
          run: () => soonToast('Вложения файлов'),
        },
        {
          id: 'composer-attach-clipboard',
          label: 'Прикрепить изображение из буфера',
          iconName: 'Image',
          flag: 'chatAttachments',
          run: () => soonToast('Вставка скриншота из буфера'),
        },
        { separator: true, id: 'sep-comp', label: '' },
        {
          id: 'composer-clear',
          label: 'Очистить поле',
          iconName: 'Eraser',
          run: () => {
            if (target.element instanceof HTMLTextAreaElement) {
              target.element.value = '';
              target.element.dispatchEvent(new Event('input', { bubbles: true }));
            }
          },
        },
        {
          id: 'composer-expand',
          label: 'Развернуть на весь экран',
          iconName: 'Maximize2',
          run: () => soonToast('Полноэкранный редактор сообщений'),
        },
        {
          id: 'composer-send',
          label: 'Отправить',
          iconName: 'Send',
          shortcut: 'Enter',
          run: () => {
            const form = target.element?.closest('form');
            if (form) form.requestSubmit();
          },
        },
      ];
    }

    case 'thread-header': {
      return [
        {
          id: 'thread-rename',
          label: 'Переименовать тред',
          iconName: 'Edit2',
          shortcut: 'F2',
          run: () => soonToast('Переименование треда'),
        },
        {
          id: 'thread-pin',
          label: 'Закрепить тред',
          iconName: 'Pin',
          run: () => soonToast('Закрепление треда'),
        },
        {
          id: 'thread-export',
          label: 'Экспорт истории',
          iconName: 'Download',
          flag: 'exportData',
          run: () => soonToast('Экспорт треда'),
        },
        {
          id: 'thread-settings',
          label: 'Настройки треда (модель, температура)',
          iconName: 'Sliders',
          run: () => soonToast('Параметры инференса треда'),
        },
        { separator: true, id: 'sep-thread', label: '' },
        {
          id: 'thread-delete',
          label: 'Удалить диалог',
          iconName: 'Trash2',
          danger: true,
          run: () => soonToast('Удаление диалога'),
        },
      ];
    }

    case 'attachment-item': {
      return [
        {
          id: 'att-open',
          label: 'Открыть',
          iconName: 'ExternalLink',
          run: () => {
            if (target.url) window.open(target.url, '_blank');
          },
        },
        {
          id: 'att-download',
          label: 'Скачать файл',
          iconName: 'Download',
          run: () => soonToast('Загрузка файла'),
        },
        {
          id: 'att-copy-link',
          label: 'Копировать ссылку на файл',
          iconName: 'Link',
          run: () => {
            if (target.url) {
              navigator.clipboard.writeText(target.url);
              emitToast({ message: 'Ссылка скопирована', tone: 'success' });
            }
          },
        },
        {
          id: 'att-rename',
          label: 'Переименовать',
          iconName: 'Edit2',
          run: () => soonToast('Переименование вложения'),
        },
        { separator: true, id: 'sep-att', label: '' },
        {
          id: 'att-delete',
          label: 'Удалить файл',
          iconName: 'Trash2',
          danger: true,
          run: () => soonToast('Удаление вложения'),
        },
      ];
    }

    case 'admin-row': {
      return [
        {
          id: 'row-edit',
          label: 'Изменить',
          iconName: 'Edit2',
          run: () => soonToast('Редактирование записи'),
        },
        {
          id: 'row-dup',
          label: 'Создать копию',
          iconName: 'Copy',
          run: () => soonToast('Дублирование конфигурации'),
        },
        {
          id: 'row-toggle',
          label: 'Включить / Выключить',
          iconName: 'ToggleRight',
          run: () => soonToast('Переключение состояния'),
        },
        {
          id: 'row-verify',
          label: 'Проверить соединение',
          iconName: 'CheckCircle',
          run: () => soonToast('Проверка доступности сервиса'),
        },
        {
          id: 'row-copy-id',
          label: 'Копировать ID',
          iconName: 'Hash',
          run: () => {
            if (target.id) {
              navigator.clipboard.writeText(target.id);
              emitToast({ message: `ID скопирован: ${target.id}`, tone: 'success' });
            }
          },
        },
        {
          id: 'row-copy-val',
          label: 'Копировать значение',
          iconName: 'Clipboard',
          run: () => {
            if (target.text) {
              navigator.clipboard.writeText(target.text);
              emitToast({ message: 'Значение скопировано', tone: 'success' });
            }
          },
        },
        { separator: true, id: 'sep-admin-row', label: '' },
        {
          id: 'row-delete',
          label: 'Удалить запись',
          iconName: 'Trash2',
          danger: true,
          run: () => soonToast('Удаление записи в админке'),
        },
      ];
    }

    case 'table-header': {
      return [
        {
          id: 'col-sort',
          label: 'Сортировать по возрастанию',
          iconName: 'ArrowUpNarrowWide',
          run: () => soonToast('Сортировка таблицы'),
        },
        {
          id: 'col-hide',
          label: 'Скрыть эту колонку',
          iconName: 'EyeOff',
          run: () => soonToast('Управление колонками'),
        },
        {
          id: 'col-reset',
          label: 'Сбросить вид таблицы',
          iconName: 'RotateCcw',
          run: () => soonToast('Сброс колонок'),
        },
      ];
    }

    case 'invite-row': {
      const isMulti = (target.selectedCount || 0) > 1;
      return [
        {
          id: 'inv-copy-code',
          label: 'Копировать код инвайта',
          iconName: 'Hash',
          run: () => {
            if (target.id) {
              navigator.clipboard.writeText(target.id);
              emitToast({ message: `Код инвайта скопирован: ${target.id}`, tone: 'success' });
            }
          },
        },
        {
          id: 'inv-copy-link',
          label: 'Копировать ссылку приглашения',
          iconName: 'Link',
          run: () => {
            const url = `${window.location.origin}/login?invite=${target.id || ''}`;
            navigator.clipboard.writeText(url);
            emitToast({ message: 'Ссылка с инвайтом скопирована', tone: 'success' });
          },
        },
        { separator: true, id: 'sep-inv', label: '' },
        {
          id: 'inv-revoke',
          label: isMulti ? `Отозвать ${target.selectedCount} инвайтов` : 'Отозвать инвайт',
          iconName: 'Ban',
          danger: true,
          run: () => soonToast('Отзыв инвайта'),
        },
        {
          id: 'inv-delete',
          label: 'Удалить из списка',
          iconName: 'Trash2',
          danger: true,
          run: () => soonToast('Удаление инвайта'),
        },
      ];
    }

    case 'kpi-card': {
      return [
        {
          id: 'kpi-refresh',
          label: 'Обновить метрику',
          iconName: 'RefreshCw',
          run: () => soonToast('Обновление KPI метрик'),
        },
        {
          id: 'kpi-copy',
          label: 'Копировать значение',
          iconName: 'Copy',
          run: () => {
            if (target.text) {
              navigator.clipboard.writeText(target.text);
              emitToast({ message: 'Значение скопировано', tone: 'success' });
            }
          },
        },
        {
          id: 'kpi-open',
          label: 'Открыть подробный раздел',
          iconName: 'ExternalLink',
          run: () => soonToast('Переход к деталям метрики'),
        },
      ];
    }

    case 'profile-avatar': {
      return [
        {
          id: 'prof-settings',
          label: 'Настройки профиля',
          iconName: 'User',
          run: () => {
            window.location.href = '/settings';
          },
        },
        {
          id: 'prof-accounts',
          label: 'Привязанные аккаунты (Discord / Web)',
          iconName: 'Link2',
          run: () => {
            window.location.href = '/settings?tab=accounts';
          },
        },
        {
          id: 'prof-appearance',
          label: 'Внешний вид и звуки',
          iconName: 'Palette',
          run: () => {
            window.location.href = '/settings?tab=appearance';
          },
        },
        { separator: true, id: 'sep-prof', label: '' },
        {
          id: 'prof-logout',
          label: 'Выйти из аккаунта',
          iconName: 'LogOut',
          run: () => {
            window.location.href = '/login';
          },
        },
        {
          id: 'prof-logout-all',
          label: 'Завершить сессии на всех устройствах',
          iconName: 'ShieldAlert',
          danger: true,
          run: () => soonToast('Завершение всех сессий'),
        },
      ];
    }

    case 'link': {
      return [
        {
          id: 'link-open',
          label: 'Открыть ссылку',
          iconName: 'ExternalLink',
          run: () => {
            if (target.url) window.location.href = target.url;
          },
        },
        {
          id: 'link-open-new',
          label: 'Открыть в новой вкладке',
          iconName: 'Compass',
          run: () => {
            if (target.url) window.open(target.url, '_blank', 'noopener,noreferrer');
          },
        },
        {
          id: 'link-copy-url',
          label: 'Скопировать адрес ссылки',
          iconName: 'Copy',
          run: () => {
            if (target.url) {
              navigator.clipboard.writeText(target.url);
              emitToast({ message: 'Адрес ссылки скопирован', tone: 'success' });
            }
          },
        },
        {
          id: 'link-copy-text',
          label: 'Скопировать текст ссылки',
          iconName: 'FileText',
          run: () => {
            if (target.text) {
              navigator.clipboard.writeText(target.text);
              emitToast({ message: 'Текст ссылки скопирован', tone: 'success' });
            }
          },
        },
      ];
    }

    case 'selection': {
      return [
        {
          id: 'sel-copy',
          label: 'Копировать выделение',
          iconName: 'Copy',
          shortcut: '⌘C',
          run: () => {
            if (target.text) {
              navigator.clipboard.writeText(target.text);
              emitToast({ message: 'Выделенный фрагмент скопирован', tone: 'success' });
            }
          },
        },
        {
          id: 'sel-search',
          label: 'Искать в истории чатов',
          iconName: 'Search',
          run: () => soonToast('Поиск фрагмента по чатам'),
        },
        {
          id: 'sel-new-chat',
          label: 'Отправить в новый диалог',
          iconName: 'MessageSquarePlus',
          run: () => soonToast('Создание чата с выделенным текстом'),
        },
        {
          id: 'sel-tts',
          label: 'Озвучить фрагмент',
          iconName: 'Volume2',
          flag: 'chatVoice',
          run: () => soonToast('Озвучивание выделенного фрагмента'),
        },
      ];
    }

    case 'image': {
      return [
        {
          id: 'img-open',
          label: 'Открыть изображение',
          iconName: 'Maximize2',
          run: () => {
            if (target.url) window.open(target.url, '_blank');
          },
        },
        {
          id: 'img-download',
          label: 'Сохранить изображение…',
          iconName: 'Download',
          run: () => soonToast('Сохранение изображения'),
        },
        {
          id: 'img-copy',
          label: 'Копировать изображение',
          iconName: 'Copy',
          run: () => soonToast('Копирование картинки в буфер'),
        },
        {
          id: 'img-copy-url',
          label: 'Копировать адрес изображения',
          iconName: 'Link',
          run: () => {
            if (target.url) {
              navigator.clipboard.writeText(target.url);
              emitToast({ message: 'URL изображения скопирован', tone: 'success' });
            }
          },
        },
      ];
    }

    default:
      return [];
  }
}
