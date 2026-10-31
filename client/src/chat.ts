export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: 'text' | 'voice';
  audioUrl?: string;
  durationMs?: number;
  pending?: boolean;
}

export interface ChatThread {
  id: string;
  title: string;
  sessionId: string;
  updated: number;
  messages: ChatMessage[];
}

export const CHAT_STORAGE_KEY = 'neyra.desktop.chats';

export function nextId(): string {
  return crypto.randomUUID();
}

export function composerSlot(text: string): 'send' | 'live' {
  return text.trim() ? 'send' : 'live';
}

export function threadTitle(messages: { role: string; content: string }[]): string {
  const first = messages.find(message => message.role === 'user' && message.content.trim());
  if (!first) return 'Новый чат';
  const clean = first.content.trim().replace(/\s+/g, ' ');
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function stripAudio(message: ChatMessage): ChatMessage {
  const copy = { ...message };
  delete copy.audioUrl;
  return copy;
}

export function wavBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/wav' });
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as ChatMessage;
  return (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && (message.kind === 'text' || message.kind === 'voice');
}

export function loadThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ChatThread => {
      if (!item || typeof item !== 'object') return false;
      const thread = item as ChatThread;
      return typeof thread.id === 'string' && typeof thread.sessionId === 'string' && Array.isArray(thread.messages) && thread.messages.every(isMessage);
    }).slice(0, 30);
  } catch {
    return [];
  }
}

export function saveThreads(threads: ChatThread[]) {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(threads.slice(0, 30).map(thread => ({ ...thread, messages: thread.messages.map(stripAudio) }))));
  } catch {
    /* The chat list is a convenience. A full disk must not block the conversation. */
  }
}
