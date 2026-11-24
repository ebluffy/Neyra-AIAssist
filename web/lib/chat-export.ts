export interface ExportAttachment {
  name?: string | null;
  mime?: string | null;
  size?: number | null;
}

export interface ExportMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ExportAttachment[];
}

export interface ChatExportSource extends ExportMessage {
  pending?: boolean;
  isRetrying?: boolean;
  error?: string | null;
  id?: string;
}

function cleanLine(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeMarkdownLine(value: string | null | undefined): string {
  return cleanLine(value).replace(/([\\`*_[\]()#<>])/g, '\\$1');
}

function exporterName(role: ExportMessage['role']): string {
  return role === 'user' ? 'Пользователь' : 'Нейра';
}

/**
 * Only the public export DTO: no UI ids, no pending/streaming messages and no
 * server error text. Failed answers keep a neutral placeholder.
 */
export function normalizeExportMessages(messages: ChatExportSource[]): ExportMessage[] {
  return messages
    .filter((message) => !message.pending && !message.isRetrying)
    .map((message) => {
      const attachments = (message.attachments ?? []).map((item) => ({
        name: cleanLine(item.name) || 'файл',
        mime: cleanLine(item.mime),
        size: typeof item.size === 'number' ? item.size : null,
      }));
      return {
        role: message.role,
        content: message.error ? '(ошибка ответа)' : message.content,
        ...(attachments.length ? { attachments } : {}),
      };
    })
    .filter((message) => message.content.trim().length > 0);
}

function attachmentLine(item: ExportAttachment): string {
  const name = escapeMarkdownLine(item.name) || 'файл';
  const meta = [
    cleanLine(item.mime),
    typeof item.size === 'number' ? `${item.size} B` : '',
  ].filter(Boolean).join(', ');
  return meta ? `- ${name} (${meta})` : `- ${name}`;
}

export function chatToMarkdown(title: string, messages: ChatExportSource[]): string {
  const safeTitle = escapeMarkdownLine(title) || 'Диалог';
  const body = normalizeExportMessages(messages)
    .map((message) => {
      const parts = [`## ${exporterName(message.role)}`, '', message.content.trim()];
      if (message.attachments?.length) {
        parts.push('', 'Вложения:', ...message.attachments.map(attachmentLine));
      }
      return parts.join('\n');
    })
    .join('\n\n');
  return `# ${safeTitle}\n\n_Экспорт Neyra · ${new Date().toISOString()}_\n\n${body}\n`;
}

export function chatToJson(title: string, messages: ChatExportSource[]): string {
  return JSON.stringify(
    {
      title: cleanLine(title) || 'Диалог',
      exported_at: new Date().toISOString(),
      messages: normalizeExportMessages(messages),
    },
    null,
    2,
  );
}

export function safeFilename(title: string): string {
  const base = cleanLine(title)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || 'neyra-dialog').slice(0, 80);
}

function triggerDownload(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function printChatPdf(title: string, messages: ChatExportSource[]): boolean {
  const win = window.open('', '_blank');
  if (!win) return false;
  const safeTitle = cleanLine(title) || 'Диалог';
  const rows = normalizeExportMessages(messages)
    .map((message) => {
      const attachments = message.attachments?.length
        ? `<ul>${message.attachments
            .map((item) => `<li>${escapeHtml(item.name || 'файл')}</li>`)
            .join('')}</ul>`
        : '';
      return `<section><h2>${escapeHtml(exporterName(message.role))}</h2><pre>${escapeHtml(
        message.content,
      )}</pre>${attachments}</section>`;
    })
    .join('');
  win.document.write(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
      safeTitle,
    )}</title><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111}h1{font-size:22px}h2{font-size:14px;color:#555;margin:18px 0 4px}pre{white-space:pre-wrap;font:inherit;margin:0}ul{font-size:12px;color:#555}</style></head><body><h1>${escapeHtml(
      safeTitle,
    )}</h1><p>Экспорт Neyra · ${escapeHtml(new Date().toISOString())}</p>${rows}</body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
  return true;
}

export function downloadChat(
  title: string,
  messages: ChatExportSource[],
  format: 'markdown' | 'json' | 'pdf',
): boolean {
  const base = safeFilename(title);
  if (format === 'markdown') {
    triggerDownload(`${base}.md`, chatToMarkdown(title, messages), 'text/markdown');
    return true;
  }
  if (format === 'json') {
    triggerDownload(`${base}.json`, chatToJson(title, messages), 'application/json');
    return true;
  }
  return printChatPdf(title, messages);
}
