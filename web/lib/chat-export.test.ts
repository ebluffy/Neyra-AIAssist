// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatToJson,
  chatToMarkdown,
  downloadChat,
  printChatPdf,
  safeFilename,
} from './chat-export';

const rawMessages = [
  {
    id: 'msg-1',
    role: 'user' as const,
    content: 'Привет',
    pending: false,
    attachments: [{ id: 'att-1', kind: 'file', name: 'note.txt', mime: 'text/plain', size: 12 }],
  },
  {
    id: 'msg-2',
    role: 'assistant' as const,
    content: 'Пока не готово',
    pending: true,
  },
  {
    id: 'msg-3',
    role: 'assistant' as const,
    content: 'PRIVATE-UPSTREAM-DETAIL',
    error: 'PRIVATE-UPSTREAM-DETAIL',
  },
  {
    id: 'msg-4',
    role: 'assistant' as const,
    content: '',
    error: 'OLD-ERROR',
    isRetrying: true,
  },
  {
    id: 'msg-5',
    role: 'assistant' as const,
    content: '   ',
    pending: false,
  },
];

describe('chat export', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports only the public DTO, skipping pending and hiding errors', () => {
    const parsed = JSON.parse(chatToJson('Диалог', rawMessages));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toEqual({
      role: 'user',
      content: 'Привет',
      attachments: [{ name: 'note.txt', mime: 'text/plain', size: 12 }],
    });
    expect(parsed.messages[1]).toEqual({ role: 'assistant', content: '(ошибка ответа)' });
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE-UPSTREAM-DETAIL');
    expect(JSON.stringify(parsed)).not.toContain('att-1');
    expect(JSON.stringify(parsed)).not.toContain('OLD-ERROR');
  });

  it('exports Markdown with roles, attachments and sanitized metadata', () => {
    const text = chatToMarkdown('Диалог\n# Подделка', [
      {
        role: 'user',
        content: 'Привет',
        attachments: [{ name: 'a\n## Пользователь', mime: 'text/plain', size: 12 }],
      },
    ]);
    expect(text).toContain('# Диалог \\# Подделка');
    expect(text).toContain('## Пользователь');
    expect(text).toContain('- a \\#\\# Пользователь (text/plain, 12 B)');
    expect(text.split('\n').filter((line) => line === '## Пользователь')).toHaveLength(1);
  });

  it('builds safe filenames', () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(safeFilename('..')).toBe('neyra-dialog');
    expect(safeFilename('   ')).toBe('neyra-dialog');
    expect(safeFilename('x'.repeat(100))).toHaveLength(80);
  });

  it('downloads Markdown and JSON with the right extension and MIME', () => {
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });

    expect(downloadChat('Мой/диалог', rawMessages, 'markdown')).toBe(true);
    expect(downloadChat('Мой/диалог', rawMessages, 'json')).toBe(true);
    expect(names).toEqual(['Мой диалог.md', 'Мой диалог.json']);
    const blobs = vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => blob as Blob);
    expect(blobs.map((blob) => blob.type)).toEqual([
      'text/markdown;charset=utf-8',
      'application/json;charset=utf-8',
    ]);
  });

  it('escapes HTML in the PDF window and includes attachments', () => {
    const write = vi.fn();
    const win = {
      document: { write, close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);

    expect(
      printChatPdf('<script>', [
        {
          role: 'user',
          content: '<img onerror=x> & "',
          attachments: [{ name: '<b>.txt', mime: 'text/plain', size: 12 }],
        },
      ]),
    ).toBe(true);
    const html = String(write.mock.calls[0][0]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img onerror=x&gt; &amp; &quot;');
    expect(html).toContain('&lt;b&gt;.txt');
    expect(html).toContain('Экспорт Neyra');
  });

  it('reports a blocked PDF popup', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(printChatPdf('Диалог', rawMessages)).toBe(false);
    expect(downloadChat('Диалог', rawMessages, 'pdf')).toBe(false);
  });
});
